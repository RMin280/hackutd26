"""The update agent (agents/patch): advisories matched by code, fixes rolled out in waves that
never take a job's or tenant's nodes, never dip below the spare reserve, put prerequisites
first, survive a restart without re-notifying, and fail closed."""

from __future__ import annotations

import json
from typing import Any

import pytest
from openai.types.chat import ChatCompletion

from agents.common.loop import issue_message
from agents.llm import ModelUnavailable, Reply
from agents.mock_squawk import JOB_ID, MockSquawk
from agents.patch.demo import run_demo
from agents.patch.fleet import Advisory, Fleet, load_advisories, older, patch_note
from agents.patch.rollout import exposure, plan_wave
from agents.patch.runner import PatchRunner
from agents.patch.scripted import ScriptedModel
from agents.patch.triage import UPDATER, triage
from agents.squawk import Event, OutOfScope

ADVISORIES = {a.id: a for a in load_advisories()}
MON, GPU, LEAF = (ADVISORIES[i] for i in ("SQK-SIM-2026-0419", "SQK-SIM-2026-0412", "SQK-SIM-2026-0433"))


def ours(br: MockSquawk, type: str = "lease_granted") -> list[Event]:
    return [e for e in br.events if e.type == type and e.actor == UPDATER]


def granted(target: str, note: str, *, until: int, start: int = 0, lease: str = "lease-x", seq: int = 1) -> Event:
    return Event(seq, start, "lease_granted", UPDATER, target, "", {"note": note, "target": target, "start": start, "until": until, "holder": UPDATER, "lease": lease})


def drain(r: PatchRunner, times: int = 3) -> None:
    for _ in range(times):
        r.drain()


# ---------------------------------------------------------------- matching, by code


def test_versions_compare_as_numbers():
    assert older("550.54.15", "550.90.07") and not older("550.90.07", "550.90.07")
    assert older("9.9", "10.0") and older("4.1.9", "4.2.1") and not older("10.6.0", "10.4.2")
    assert older("1.0", "1.0.1") and isinstance(older("1.0-rc1", "1.0.1"), bool)  # mixed parts never raise


def test_advisories_load_worst_first_and_reject_odd_ids(tmp_path):
    assert [a.id for a in load_advisories()] == ["SQK-SIM-2026-0419", "SQK-SIM-2026-0412", "SQK-SIM-2026-0433"]
    feed = tmp_path / "a.json"
    feed.write_text(json.dumps({"advisories": [
        {"id": "ok-1", "component": "leaf_os", "fixed": "1", "severity": "weird"},
        {"id": "bad id; DROP", "component": "leaf_os", "fixed": "1", "severity": "low"},
    ]}))  # fmt: skip
    (a,) = load_advisories(feed)
    assert a.id == "ok-1" and a.severity == "high"  # unknown severity is treated as serious


def test_only_our_own_granted_windows_count_as_patched():
    fleet = Fleet.load()
    forged = Event(1, 0, "lease_granted", "Facility tech", "row-9", "", {"note": "patch X: monitoring_agent 9.9.9", "target": "row-9", "until": 0, "holder": "Facility tech"})
    real = Event(2, 0, "lease_granted", UPDATER, "row-10", "", {"note": patch_note(MON, "monitoring_agent", "4.2.1", "free text"), "target": "row-10", "until": 30, "holder": UPDATER})
    fleet.observe(forged)
    fleet.observe(real)
    assert fleet.version("monitoring_agent", 9, "row-9", now=100) == "4.1.9"
    assert fleet.version("monitoring_agent", 10, "row-10", now=10) == "4.1.9"  # still running at T+10m
    assert fleet.version("monitoring_agent", 10, "row-10", now=30) == "4.2.1"


def test_triage_opens_an_issue_with_counts_and_fences_the_advisory_text():
    br, fleet = MockSquawk(), Fleet.load()
    issue = triage(GPU, fleet, br, {}, set())
    f = issue.facts
    assert (f["ready_now"], f["held_by_owners"], f["rows"]) == (160, {"tenant-gamma": 96}, [9, 10])
    assert f["owners"] == ["tenant-gamma"] and f["tell_shift_lead"] is False
    assert f["prerequisites"] == {"BMC firmware": "3.2.0"}
    assert triage(MON, fleet, br, {}, set()).facts["tell_shift_lead"] is True  # critical and exploited
    assert "<untrusted>" in issue_message(issue) and GPU.summary[:30] in issue_message(issue)


def test_software_with_no_patch_procedure_goes_to_a_person():
    adv = Advisory("SQK-X", "bios", "2.0", "high", 8.0, False)
    item = triage(adv, Fleet.load(), MockSquawk(), {}, set())
    assert item.to == "shift lead" and "bios" in item.reason


# ---------------------------------------------------------------- waves


def test_first_wave_is_a_canary_then_waves_grow():
    br, fleet = MockSquawk(), Fleet.load()
    first = plan_wave(GPU, fleet, br, 16, exposure(GPU, fleet, br))
    assert first.canary and len(first.targets) == 2
    fleet.observe(granted(first.targets[0], patch_note(GPU, "gpu_driver", "550.90.07"), until=0))
    later = plan_wave(GPU, fleet, br, 16, exposure(GPU, fleet, br))
    assert not later.canary and len(later.targets) == 16


def test_prerequisite_firmware_is_booked_first_back_to_back():
    br, fleet = MockSquawk(), Fleet.load()
    wave = plan_wave(GPU, fleet, br, 2, exposure(GPU, fleet, br))
    b = wave.bookings
    assert [(x.component, x.start_in, x.minutes) for x in b[:2]] == [("bmc_firmware", 0, 60), ("gpu_driver", 60, 90)]
    assert b[0].target == b[1].target


def test_the_spare_reserve_is_never_used(monkeypatch):
    monkeypatch.setenv("PATCH_SPARE_RESERVE", "159")  # 160 spares: room for one node
    br = MockSquawk()
    r = PatchRunner(br, ScriptedModel(), [GPU], Fleet.load())
    drain(r)
    assert len({e.subject for e in ours(br)}) == 1
    assert len(br.free_spares()) >= 159


def test_the_storyline_never_takes_a_job_or_tenant_node_and_keeps_the_reserve():
    br, runner = run_demo(ScriptedModel(), out=lambda s: None)
    for e in ours(br):
        if e.data.get("kind") == "sw_online":
            continue  # live patches run alongside jobs by design
        nodes = br._software_nodes(e.subject)
        owners = {br.owner[n].kind for n in nodes}
        # exclusive work only on nodes that were free, or the leaf of a finished job
        assert owners <= {"free"} or (e.subject.startswith("sw-leaf") and br.jobs[JOB_ID]["status"] == "finished" and e.time >= 400), e
    assert not [o for o in runner.outcomes if o.status in ("handed_off", "failed_closed")]
    assert sum(o.model_calls for o in runner.outcomes) <= 10 * len(runner.outcomes)


def test_switch_firmware_waits_for_the_job_while_the_rest_goes_on():
    br = MockSquawk()
    r = PatchRunner(br, ScriptedModel(), [LEAF], Fleet.load())
    drain(r)
    assert not ours(br)  # Leaf R1 sits above job-train-1: refused, parked on the job
    assert [e.subject for e in ours(br, "lease_denied")] == ["sw-leaf-r1"]
    assert any(e.data.get("to") == "shift lead" for e in ours(br, "notified"))  # a person decides on draining
    for t in (60, 120, 180, 240, 300):
        br.advance(t)
        drain(r)
    denied = [e.subject for e in ours(br, "lease_denied")]
    assert len(denied) == len(set(denied)), "a parked switch is never asked for twice"
    assert not [e for e in ours(br) if e.subject in [f"sw-leaf-r{i}" for i in range(1, 9)]]  # nothing above the running job
    br.set_job_status(JOB_ID, "finished")
    for t in (360, 420):
        br.advance(t)
        drain(r)
    assert "sw-leaf-r1" in [e.subject for e in ours(br)]


def test_a_warn_is_filed_once_and_a_shift_lead_approval_counts_as_patched():
    from agents.patch.fleet import patch_note as note

    fleet = Fleet.load()
    approved = Event(9, 50, "lease_granted", "shift-lead", "row-3", "", {"note": note(MON, "monitoring_agent", "4.2.1"), "target": "row-3", "until": 80, "holder": UPDATER, "lease": "#9"})
    fleet.observe(approved)
    assert fleet.version("monitoring_agent", 3, "row-3", now=80) == "4.2.1"
    fleet.observe(Event(10, 60, "lease_released", "shift-lead", "#9", "", {"lease": "#9"}))  # cut short
    assert fleet.version("monitoring_agent", 3, "row-3", now=90) == "4.1.9"


def test_no_waves_and_no_model_calls_while_spares_are_at_the_reserve(monkeypatch):
    monkeypatch.setenv("PATCH_SPARE_RESERVE", "160")
    br = MockSquawk()
    r = PatchRunner(br, ScriptedModel(), [GPU], Fleet.load())
    drain(r)  # first run: tells tenant-gamma, books nothing
    calls = sum(o.model_calls for o in r.outcomes)
    for t in (60, 120, 180, 240):
        br.advance(t)
        drain(r)
    assert not ours(br) and sum(o.model_calls for o in r.outcomes) == calls


def test_a_restarted_agent_rebuilds_from_the_feed_and_tells_nobody_twice():
    br = MockSquawk()
    drain(PatchRunner(br, ScriptedModel(), [MON, GPU], Fleet.load()))
    br.advance(200)
    drain(PatchRunner(br, ScriptedModel(), [MON, GPU], Fleet.load()))  # a new process
    told = [(e.subject, e.data["to"]) for e in ours(br, "notified") if e.subject.startswith("SQK-")]  # not the failed canary node
    assert len(told) == len(set(told)) == 2  # the shift lead about the critical one, tenant-gamma about the driver
    mon = [e for e in ours(br) if e.data.get("kind") == "sw_online"]
    # canary row, then a wave (not a second canary); row-9 waits behind the hold on the failed canary node-1029
    assert len(mon) == 8 and mon[0].time == 0 and all(e.time == 200 for e in mon[1:])


def test_the_agent_finishes_once_every_target_is_patched():
    br = MockSquawk()
    r = PatchRunner(br, ScriptedModel(), [MON], Fleet.load())
    for t in (0, 40, 80, 120):
        br.advance(t)
        drain(r)
    fixed = [e for e in ours(br, "agent") if e.data.get("status") == "fixed"]
    assert len(fixed) == 1 and "4.2.1" in fixed[0].reason


# ---------------------------------------------------------------- guardrails


class DownModel:
    def chat(self, messages, **kwargs) -> Reply:
        raise ModelUnavailable("Primary: down. Backup: down.")


class ListModel:
    def __init__(self, *steps: tuple[str, dict[str, Any]]) -> None:
        self.steps, self.calls = list(steps), 0

    def chat(self, messages, **kwargs) -> Reply:
        name, args = self.steps[min(self.calls, len(self.steps) - 1)]
        self.calls += 1
        msg = {"role": "assistant", "content": None, "tool_calls": [{"id": f"c{self.calls}", "type": "function", "function": {"name": name, "arguments": json.dumps(args)}}]}
        c = ChatCompletion.model_validate({"id": "x", "object": "chat.completion", "created": 0, "model": "list", "choices": [{"index": 0, "message": msg, "finish_reason": "stop"}]})
        from agents.common.scripted import SCRIPTED

        return Reply(c, SCRIPTED)


def test_no_model_means_nothing_is_booked_and_a_person_hears_about_it():
    br = MockSquawk()
    r = PatchRunner(br, DownModel(), [GPU], Fleet.load())
    drain(r)
    assert not ours(br) and r.outcomes[0].status == "failed_closed"
    assert any("Fail closed" in e.reason for e in ours(br, "escalated"))
    drain(r)
    assert len(r.outcomes) == 1  # backs off instead of retrying every drain


def test_finishing_with_targets_left_is_not_accepted():
    br = MockSquawk()
    plan = {"steps": [{"tool": "check_wave", "why": "t"}, {"tool": "notify_owners", "why": "t"}, {"tool": "finish", "why": "t"}]}
    model = ListModel(("submit_plan", plan), ("check_wave", {"size": 2}), ("notify_owners", {"message": "m"}), ("finish", {"summary": "all done"}))
    r = PatchRunner(br, model, [GPU], Fleet.load())
    drain(r, 1)
    assert r.outcomes[0].status == "handed_off" and "can still be patched" in r.outcomes[0].summary


def test_the_model_can_not_pick_targets_or_book_hardware_work():
    from agents.patch.playbooks import TOOLS

    for name in ("check_wave", "book_wave"):
        assert not {"target", "targets", "node", "row"} & set(TOOLS[name].schema()["function"]["parameters"]["properties"])
    br = MockSquawk()
    with pytest.raises(OutOfScope):
        br.request_work("update-agent", "sw_exclusive", "node-1028") and br.request_lease("update-agent", target="cdu-4", minutes=60)
    from agents.squawk_http import HttpSquawk

    with pytest.raises(OutOfScope):
        HttpSquawk(transport=None, actor="update-agent").request_work("update-agent", "facility_work", "cdu-4")  # type: ignore[arg-type]


def test_a_restart_mid_wave_waits_for_the_running_wave():
    br = MockSquawk()
    first = PatchRunner(br, ScriptedModel(), [MON, GPU], Fleet.load())
    drain(first)
    booked = len(ours(br))
    second = PatchRunner(br, ScriptedModel(), [MON, GPU], Fleet.load())  # restarted at the same moment
    drain(second)
    assert len(ours(br)) == booked and not second.outcomes  # no new wave, no model calls
    br.advance(160)
    drain(second)
    assert len(ours(br)) > booked  # the next waves go once the running ones have ended


# ---------------------------------------------------------------- failed installs


def faulty(tmp_path, *faults: dict[str, Any]) -> Fleet:
    """The demo inventory with its install faults replaced."""
    from agents.patch.fleet import DATA

    raw = json.loads((DATA / "inventory.json").read_text())
    raw["install_faults"] = list(faults)
    path = tmp_path / "inventory.json"
    path.write_text(json.dumps(raw))
    return Fleet.load(path)


def held_by_us(br: MockSquawk, node: str) -> bool:
    return any(lease.actor == UPDATER for lease in br.leases_on(node))


def test_a_failed_window_leaves_the_old_version_and_a_retry_or_rollback_is_read_back():
    fleet = Fleet.load()

    def drv(kind: str = "patch", v: str = "550.90.07") -> str:
        return patch_note(GPU, "gpu_driver", v, kind=kind)

    fleet.observe(granted("node-1029", drv(), until=90, lease="l1", seq=1))
    assert fleet.status("gpu_driver", "node-1029", 50) == "running"
    assert fleet.status("gpu_driver", "node-1029", 90) == "failed"  # inventory: node-1029 fails its first install
    assert fleet.version("gpu_driver", 9, "node-1029", 90) == "550.54.15"
    assert fleet.failures(GPU, 90) == [("gpu_driver", "node-1029")]
    assert fleet.canary("gpu_driver", "550.90.07", "node-1029")
    fleet.observe(granted("node-1029", drv(), start=100, until=190, lease="l2", seq=2))
    assert fleet.broken(GPU, "node-1029", 150) == "failed"  # a running retry is still the failure's
    assert fleet.status("gpu_driver", "node-1029", 190) == "ok" and fleet.version("gpu_driver", 9, "node-1029", 190) == "550.90.07"
    fleet.observe(granted("node-1037", drv(), until=90, lease="l3", seq=3))
    fleet.observe(granted("node-1037", drv("rollback", "550.54.15"), start=100, until=190, lease="l4", seq=4))
    assert fleet.status("gpu_driver", "node-1037", 190) == "rolled_back" and fleet.broken(GPU, "node-1037", 190) == "rolled_back"
    assert fleet.attempt("gpu_driver", "node-1037", "550.90.07") == 1  # a rollback isn't a try


def test_the_storyline_retries_the_canary_and_rolls_back_a_node_that_fails_twice():
    br, runner = run_demo(ScriptedModel(), out=lambda s: None)
    agent = ours(br, "agent")
    fixed = [e for e in agent if e.subject == "node-1029" and e.data.get("status") == "fixed"]
    rolled = [e for e in agent if e.subject == "node-1037" and e.reason.startswith("ROLLED BACK")]
    assert len(fixed) == 1 and "attempt 2" in fixed[0].reason
    assert len(rolled) == 1 and "550.54.15" in rolled[0].reason
    assert [e.data["attempt"] for e in agent if e.data.get("status") == "patch_failed"] == [1, 1, 2]
    lead = {e.subject for e in ours(br, "notified") if e.data.get("to") == "shift lead"}
    assert {"node-1029", "node-1037"} <= lead  # the failed canary, and the rollback
    assert "SQK-SIM-2026-0412" not in runner.stopped  # one rollback outside the canary doesn't stop the advisory
    assert runner.fleet.version("gpu_driver", 9, "node-1037", br.now) == "550.54.15"
    # No new driver wave while node-1029's failure was open (from its failure row to its fix row).
    failed_at = next(e.seq for e in agent if e.subject == "node-1029" and e.data.get("status") == "patch_failed")
    driver = {f"node-{n}" for n in range(1028, 1281)} - {"node-1029"}
    assert not [e for e in ours(br) if failed_at < e.seq < fixed[0].seq and e.subject in driver and "gpu_driver" in str(e.data.get("note"))]


def test_a_failed_node_is_held_out_of_service_until_a_person_or_a_window_takes_over(tmp_path):
    br = MockSquawk()
    fleet = faulty(tmp_path, {"component": "gpu_driver", "version": "550.90.07", "target": "node-1029", "fails": 1, "symptom": "x"})
    r = PatchRunner(br, DownModel(), [GPU], fleet)
    r.fleet.observe(granted("node-1029", patch_note(GPU, "gpu_driver", "550.90.07"), until=90, lease="pre", seq=0))
    br.advance(100)
    drain(r)  # the model is down: the failure run fails closed, but code already holds the node
    assert held_by_us(br, "node-1029") and "node-1029" not in {n.id for n in br.free_spares()}
    assert any(o.issue.kind == "patch_failed" and o.status == "failed_closed" for o in r.outcomes)


def test_a_rolled_back_canary_stops_the_advisory_for_a_person(tmp_path):
    br = MockSquawk()
    fleet = faulty(tmp_path, {"component": "gpu_driver", "version": "550.90.07", "target": "node-1029", "fails": 5, "symptom": "x"})
    r = PatchRunner(br, ScriptedModel(), [GPU], fleet)
    for t in (0, 160, 260, 360, 460, 560):
        br.advance(t)
        drain(r)
    assert "SQK-SIM-2026-0412" in r.stopped
    assert any(e.subject == "SQK-SIM-2026-0412" and "Stopped the rollout" in e.reason for e in ours(br, "escalated"))
    tries = [e for e in ours(br) if e.subject == "node-1029" and str(e.data.get("note", "")).startswith("patch ") and "gpu_driver" in e.data["note"]]
    assert len(tries) == 2  # the first try and one retry, never a third
    assert {e.subject for e in ours(br) if "gpu_driver" in str(e.data.get("note"))} == {"node-1028", "node-1029"}  # never past the canary


def test_a_third_try_is_refused_by_code_whatever_the_model_asks(tmp_path):
    from agents.patch.playbooks import FAILURE_TOOLS

    fleet = faulty(tmp_path)
    for i in (1, 2):
        fleet.observe(granted("node-1029", patch_note(GPU, "gpu_driver", "550.90.07"), start=i * 100, until=i * 100 + 90, lease=f"t{i}", seq=i))

    class R:  # just what the gate reads
        extra = {"fleet": fleet, "component": "gpu_driver", "target": "node-1029", "version": "550.90.07"}

    assert "used up" in FAILURE_TOOLS["retry_patch"].gate(R())  # type: ignore[arg-type]
    assert not {"target", "node", "version"} & set(FAILURE_TOOLS["roll_back"].schema()["function"]["parameters"]["properties"])
