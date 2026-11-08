"""The fixer agent: Nemotron fixes low-criticality issues, only through Blast Radius.

triage.py decides (deterministically) what counts as low; playbooks.py holds the tools
and checks for each issue type; agent.py runs the model loop; runner.py watches events.
"""
