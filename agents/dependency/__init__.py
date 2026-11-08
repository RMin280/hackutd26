"""The dependency agent: catches services we rely on that say they're up while a feature
we use is broken (gray failures), and responds through Blast Radius.

triage.py decides (deterministically) what the agent works; playbooks.py holds its
tools and done checks; agent.py runs the shared model loop; runner.py runs the
scheduled feature tests and watches events. See agents/DEPENDENCY_AGENT.md.
"""
