# 🛡️ Autonomous QA Agent (GenAI Powered)

> **Next-generation website testing.** An autonomous agent that combines rigorous heuristic scanning with **Google Gemini Multimodal AI** to explore, interact, and perform visual quality assurance on any web application.

![TypeScript](https://img.shields.io/badge/TypeScript-5.0-3178c6.svg)
![Playwright](https://img.shields.io/badge/Playwright-Test-45ba4b.svg)
![Gemini AI](https://img.shields.io/badge/AI-Gemini%202.5%20Flash-8e75b2.svg)
![License](https://img.shields.io/badge/License-MIT-green.svg)

---

## 🚀 Overview

This is not just a scraper; it is an intelligent testing entity. The Autonomous QA Agent navigates web applications just like a human user, but with the precision of a machine.

It operates on a **Hybrid Architecture**:
1.  **Heuristic Engine:** Instantaneously detects objective failures (HTTP 404/500, Console Errors, Broken Images, SEO gaps).
2.  **Cognitive AI Engine:** Uses **Gemini 2.5 Flash** to visually "see" the page, understand UI context, plan autonomous workflows (filling forms, navigating complex SPAs), and detect subjective visual bugs.

## ✨ Key Features

### 🧠 Cognitive Intelligence
*   **Visual Understanding:** Takes snapshots of the UI and uses Vision LLMs to detect layout shifts, overlapping text, and rendering issues.
*   **Autonomous Navigation:** The AI decides *what* to click based on the page context (e.g., "This is a crypto exchange; I should try to connect a wallet").
*   **Self-Correction:** Smart retry logic for handling network flakiness or dynamic DOM updates.

### ⚡ Rigorous Testing Modules
The agent executes **23 distinct testing protocols** in every run:
*   **Deep Crawl:** Maps site topology and validates internal links.
*   **Workflow Tests:** Automated form filling, modal/dialog interactions, wallet connect flows, and navigation history checks.
*   **Resiliency:** Fuzz-testing inputs and checking for application crashes.

### 📊 Professional Reporting
*   **Evidence-Based:** Every bug found is logged with a screenshot, a timestamp, and a reproduction trace.
*   **Markdown Reports:** Generates a clean `report.md` summary suitable for GitHub Issues or Jira.
*   **Artifact Retention:** Automatically archives screenshots and logs per run.

---

## 🛠️ Installation

### Prerequisites
*   Node.js (v18 or higher)
*   A Google Gemini API Key ([Get it here](https://aistudio.google.com/apikey))

### Setup
1.  **Clone the repository:**
    ```bash
    git clone https://github.com/your-repo/qa-agent.git
    cd qa-agent
    ```

2.  **Install dependencies:**
    ```bash
    npm install
    ```

3.  **Install Browser Binaries:**
    ```bash
    npx playwright install chromium
    ```

4.  **Configure Environment:**
    Create a `.env` file in the root directory:
    ```ini
    # .env
    GEMINI_API_KEY=your_actual_api_key_here
    
    # Optional Tuning
    NAV_TIMEOUT_MS=60000         # Navigation timeout (default: 60s)
    HEADLESS=true                # Set to false to watch the browser in action
    ```

---

## ⚙️ Configuration & Models

The agent utilizes a generic model strategy to balance cost and performance:

| Function | Model | Reason |
| :--- | :--- | :--- |
| **Logic & Planning** | `Gemini 2.5 Flash Lite` | High speed, higher rate limits (RPM), excellent text reasoning. |
| **Vision & Analysis** | `Gemini 2.5 Flash` | Multimodal capabilities for analyzing screenshots and spotting UI bugs. |

*Note: The agent automatically handles rate-limiting and retries.*

---

## 🕹️ Usage

Run the agent interactively:

```bash
npm start
```

### The Interactive CLI
The agent will prompt you for:
1.  **Target URL:** The entry point for the test (e.g., `https://staging.example.com`).
2.  **Scope / Ad-hoc Notes:** Context for the AI (e.g., "Focus on the checkout flow" or "Sanity check for the new header").

### Sample Output
```text
============================================
     Playwright QA Agent  --  Deep Scan      
============================================
Target: http://localhost:3000
...
[+] Running Workflow 15: Site Crawler...
[+] Running Workflow 19: Wallet Connect Flow...
[+] AI Decision: Identified "Sign Up" button. Intent: Click to verify route.
...
[!] Bug Found: Console Error detected on /dashboard
    -> Saved screenshot: output/run-XYZ/screenshots/bug-console-1.png
...
## Finished. Report generated at output/run-XYZ/report.md
```

---

## 📂 Output Artifacts

Results are stored in the `output/` directory, organized by run timestamp:

```text
output/
└── run-2026-02-09T08-30-00/
    ├── report.md           <-- The Executive Summary & Bug List
    ├── debug_log.txt       <-- Verbose technical logs
    └── screenshots/        <-- Proof of bugs (Auto-linked in report)
        ├── bug_01_layout.png
        ├── bug_02_console.png
        └── trace_01_context.png
```

---

## 🔮 Roadmap & Future Improvements

To evolve this tool into an enterprise-grade QA Platform:

1.  **CI/CD Pipeline Integration**:
    *   Add a GitHub Action / GitLab CI runner mode (headless, non-interactive) that fails the build on Critical bugs.
    *   Output JUnit XML reports for dashboard integration.

2.  **Session Replay & Video**:
    *   Record full video of the AI's exploration session (using Playwright Tracing).
    *   Allow "Time Travel" debugging to see exactly what state caused a crash.

3.  **Authentication Handling**:
    *   Smart login module: Provide credentials via `.env` and let the AI detect and handle the login flow automatically before testing protected routes.
    *   Support for 2FA/OTP injection.

4.  **Advanced "Attack" Modes**:
    *   **Chaos Monkey:** Intentionally throttle network conditions or simulate mobile device constraints.
    *   **Security Scanning:** Basic XSS payload injection and SQLi heuristic checks on form inputs.

5.  **Benchmarking & Regression**:
    *   Compare current run metrics (Lighthouse scores, load times) against previous baselines.
    *   Alert on performance regression > 10%.

6.  **Multi-Agent Swarm**:
    *   Deploy multiple AI agents in parallel: one exploring "User Profile", one testing "Checkout", one testing "Admin Panel".

---

## 🤝 Contributing

Capabilities are modular. To add a new heuristic test, add a function to `src/qaAgent.ts` and register it in the `main()` execution loop.

## 📄 License

This project is licensed under the MIT License.
