# Playwright QA Agent

A minimal Playwright-powered agent that prompts for a target URL, runs a few sanity checks, captures evidence, and writes a Markdown bug report plus screenshots per run.

## Setup

1. Install dependencies:
   - `npm install`
2. Install the Chromium browser binaries for Playwright (one time):
   - `npx playwright install chromium`

## Run

`npm start`

The agent will prompt for:
- Target URL (required)
- Scope/notes (optional)

Each run creates `output/run-<timestamp>/` containing:
- `report.md` — Markdown findings with bug entries and screenshot references.
- `screenshots/` — Evidence PNGs, one per bug.

## What it checks (first pass)
- Navigation success and top-level HTTP status.
- Empty or missing `<title>`.
- Broken `<img>` elements.
- Console errors and uncaught exceptions during load.

You can extend `src/qaAgent.ts` with additional heuristics (form validation, accessibility scans, flow scripts) as needed.
