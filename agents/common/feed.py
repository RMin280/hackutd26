"""One decision-feed line per Squawk event, for the terminal storylines. The
frontend renders the same events its own way (MERGE.md §4)."""

from __future__ import annotations

from ..squawk import Event, fmt_time, label


def describe(e: Event) -> str:
    d = e.data
    head = f"{fmt_time(e.time):>7}  {e.actor:<16} "
    if e.type == "state_change":
        report = f'  Report: "{d["note"]}"' if d.get("note") else ""
        return head + f"{label(e.subject)} {d['state']}.{report}"
    if e.type == "lease_granted":
        return head + f"GRANTED {d['lease']} on {label(e.subject)} until {fmt_time(d['until'])}. {e.reason}"
    if e.type == "lease_denied":
        safe = f" Earliest safe: {d['earliest_safe']}." if d.get("earliest_safe") else ""
        return head + f"{d['verdict'].upper()} {label(e.subject)}: {e.reason}{safe}"
    if e.type == "lease_released":
        return head + f"RELEASED {e.subject}. {e.reason}"
    if e.type == "release_denied":
        return head + f"REFUSED release of {e.subject}: {e.reason}"
    if e.type == "tech_dispatched":
        return head + f"{e.reason} Note: {d.get('note')}"
    if e.type == "notified":
        return head + f"To {d['to']}{' by email' if d.get('channel') == 'email' else ''}: {d['message']}"
    if e.type == "approval_requested":
        return head + f"{e.reason} {d.get('summary', '')}"
    if e.type == "escalated":
        return head + f"HANDOFF to {d['to']}: {e.reason}"
    if e.type == "feature_state":
        word = "DEGRADED" if d["state"] == "degraded" else "RECOVERED"
        return head + f"{label(e.subject)} {word}. {e.reason}"
    if e.type == "agent_plan":
        pad = " " * len(head)
        lines = [head + ("REVISED PLAN" if d.get("revision") else "PLAN") + (f" ({d['change']})" if d.get("change") else "") + ":"]
        for i, step in enumerate(d.get("steps") or [], 1):
            when = f" [{step['when']}]" if step.get("when") else ""
            lines.append(f"{pad}  {i}. {step['tool']}{when}: {step['why']}")
        if d.get("thinking"):
            lines.append(f"{pad}  thinking: {d['thinking']}")
        return "\n".join(lines)
    return head + e.reason
