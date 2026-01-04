# agents/adk_agent/agent.py
import os
from typing import List, Dict, Any

# ADK agent classes
from google.adk.agents import LlmAgent, ParallelAgent, SequentialAgent
from google.adk.tools.google_search_tool import google_search

# Pick a model (override via env if you want)
GEMINI_MODEL = os.getenv("GEMINI_MODEL", "gemini-2.5-flash")

#
# --- Helper: short prompt-safe wrapper for file list -> text ---
#
def build_files_summary(files: List[Dict[str, Any]]) -> str:
    """
    Convert the incoming files metadata into short bullet-text
    that we can feed into agents. This keeps prompts simple.
    Each file item: { "filename": "...", "additions": int, "deletions": int }
    """
    if not files:
        return "No file list provided."
    lines = []
    for f in files:
        filename = f.get("filename", "<unknown>")
        adds = f.get("additions", 0)
        dels = f.get("deletions", 0)
        lines.append(f"- {filename} (+{adds}/-{dels})")
    return "Files changed:\n" + "\n".join(lines)


#
# --- 1) Specialized LLM agents (they write small, focused outputs) ---
#
# Note: We give each agent an output_key so they can store their result
# into the session state for the merger agent to read.
#

reviewer_agent = LlmAgent(
    name="ReviewerAgent",
    model=GEMINI_MODEL,
    instruction="""
You are a focused PR reviewer. Input: a short list of files + a brief PR description.
Task:
- Produce a concise PR summary (3 bullets max).
- List up to 3 potential functional/logic risks (each 1 sentence).
- Suggest one concrete fix for the top risk (one sentence).
Output:
Return plain Markdown only; keep it short and actionable.
""",
    description="Gives a concise functional review and one suggested fix.",
    output_key="reviewer_result"
)

security_agent = LlmAgent(
    name="SecurityAgent",
    model=GEMINI_MODEL,  # required for Google Search
    instruction="""
You are a security-focused code reviewer. Input: files changed and a brief PR note.

Task:
- Identify up to 3 potential security vulnerabilities or risky patterns based on the file names or code hints.
- For each issue, perform a quick Google Search using the 'google_search' tool to find recent exploits or CVEs related to this vulnerability.
- Provide a short remediation tip (1 sentence) for each potential vulnerability.
- Summarize only the findings grounded in recent data from the search; do NOT invent issues.
- For every source you use, generate a proper Markdown clickable link at the end of the paragraph, like so:
   Example: [Reference 1](https://example.com/vuln1)
- Do not omit the reference URLs. They must be fully clickable in Markdown.

Output:
Return plain Markdown only, with small bullet points, including references to any found vulnerabilities or CVEs.
""",
    description="Detects likely security issues and suggests remediations using Google Search for recent vulnerabilities.",
    tools=[google_search],   # single tool per agent
    output_key="security_result"
)

style_agent = LlmAgent(
    name="StyleAgent",
    model=GEMINI_MODEL,
    instruction="""
You are a style and consistency reviewer. Input: files changed and a brief PR note.
Task:
- Point out style issues or inconsistent naming/formatting (up to 5 bullets).
- Suggest small refactor/naming changes where appropriate (1 sentence each).
Output:
Return plain Markdown only.
""",
    description="Points out style, naming, and formatting issues.",
    output_key="style_result"
)


#
# --- 2) ParallelAgent runs those three concurrently ---
#
parallel_review_agent = ParallelAgent(
    name="ParallelReviewAgent",
    sub_agents=[reviewer_agent, security_agent, style_agent],
    description="Runs reviewer, security, and style agents concurrently."
)


#
# --- 3) Merger agent: synthesize outputs from session state keys ---
#
merger_agent = LlmAgent(
    name="SynthesisAgent",
    model=GEMINI_MODEL,
    instruction="""
You are an AI assistant responsible for combining results from multiple parallel agents.

**Instructions:**

1. At the very top, provide a concise summary (2-3 sentences) of the research agents' findings.
2. Below the summary, include a collapsible section using Markdown `<details>` for all parallel agents' raw outputs.
3. Each agent's output should have a heading, and the SecurityAgent output must be preserved verbatim including references and links. These references and links should be clickable in Markdown.
4. Use the following format:

## Summary
<Your summary combining research agents' results only and any suggested fixes. Use bullet points and headings if necessary>

<details>
<summary>Click to view full agent results</summary>

### Style Agent Result
{style_result}

### Reviewer Agent Result
{reviewer_result}

### Security Agent 
{security_result}

</details>

**Constraints:**
- Do NOT remove or alter any references in the SecurityAgent output.
- Maintain headings exactly as shown.
- Output only Markdown content, ready to display in a Markdown viewer.
"""
)



#
# --- 4) Sequential pipeline: run the parallel agent, then the merger ---
#
sequential_pipeline_agent = SequentialAgent(
    name="ReviewPipeline",
    sub_agents=[parallel_review_agent, merger_agent],
    description="Run multiple specialized review agents in parallel and synthesize their outputs."
)

# ADK expects a variable named root_agent to discover the agent
root_agent = sequential_pipeline_agent
