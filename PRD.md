Summary: This Product Requirement Document outlines the architecture for ai-storm, a local-first collaborative canvas powered by a Node backend that streams local tmux terminal data into a multi-workspace BlockSuite environment using a stateful parsing buffer.
Product Requirement Document (PRD)
Project Name: ai-storm (v3.0)
1. Executive Summary & Core Objectives
ai-storm is a localized, framework-agnostic collaborative product brainstorming workspace designed to translate creative, conversational ideation into structural, executable developer workflows. The application completely avoids external AI API connections, subscription models, or cloud-hosted keys. Instead, it reuses existing local command-line interface subscriptions by tapping directly into active pseudo-terminals and headless terminal sessions running on the developer's machine.
By integrating BlockSuite into a highly responsive user interface, the system gives the user an infinite visual layout to organize notes while concurrently streaming real-time local text generation directly into structured document blocks. The backend layer is powered entirely by a lightweight, local-only execution environment built on the Node runtime, using a Hono HTTP/WebSocket server and @lydell/node-pty for real pseudo-terminals (ConPTY on Windows, forkpty on POSIX).
2. High-Level Workflows & User Persona
The target user is an independent software engineer or product builder who values speed, local data privacy, and minimal tooling friction. The system facilitates a seamless three-stage workflow:
Multi-Project Brainstorming: The developer stands up isolated workspaces to explore multiple disparate product ideas concurrently, using a sidebar to snap between project canvases instantly.
Structured Synchronization: As a local terminal session generates suggestions, the web interface intelligently converts chaotic terminal output streams into clean, editable document components and notes.
Local Agent Hand-off: Once a specific feature canvas or technical specification is refined, the user highlights the target blocks to trigger a local automated code generation pipeline via their system's terminal orchestrator tools.
3. Functional Requirements
3.1. Dual-Pane Operational Interface
Conversational Control Hub (Right Pane): A dedicated interface providing user prompt inputs, terminal execution status logs, session controls, and diagnostic readouts of the background terminal stream. It can be the streamed terminal like gotty to ease the AI conversation but is up to complexity.
Structural Workspace Canvas (Left Pane): An embedded instance of BlockSuite that operates in a framework-agnostic capacity. It must support fluid, client-side toggling between a linear document configuration and a spatial node canvas. Both layouts must read and write to the exact same underlying project data structure.
3.2. Contextual Document Ingestion (Input Layer)
Prior to dispatching a user command or contextual update to the local terminal loop, a background compilation service must serialize the current state of the active BlockSuite canvas into a normalized, raw text document.
This text representation must automatically inject itself into the payload context, providing the local agent terminal execution loop with a complete structural memory of the whiteboard state.
3.3. Stateful PTY Terminal Ingestion Engine (Output Layer)
The Slicing & Chunking Buffer: The application must implement a stateful text accumulator to ingest incoming data from the local terminal stream. The system cannot assume lines or delimiters arrive cleanly. It must buffer raw string fragments until structural boundaries, line breaks, or carriage returns can be programmatically verified at the character level.
Terminal Garbage Elimination: The ingest engine must filter and strip all incoming ANSI escape sequences, color styling parameters, text animations, and terminal loading indicators to produce clean, uncorrupted strings.
Structural Block Translation: The text parser must continuously scan the stateful text buffer. Upon confirming structural Markdown indicators at line beginnings, it must programmatically declare block boundaries in the active document model, initializing new headings, bullet points, checkbox task targets or notes accordingly.
3.4. Multi-Workspace Management & Sidebar Navigation
Workspace Segregation: The system must enforce strict isolation between multiple concurrently running project workspaces. Each workspace retains its own distinct structural document layout, independent chat histories, local process bindings, and configuration metadata.
Global Navigation Framework: A persistent vertical navigation sidebar must render on the screen. It must list all active, historical, or running workspaces with human-readable titles and system status tracking (e.g., active stream state vs. idle state).
Sub-100ms Hot-Switching: Clicking any project in the sidebar must instantly unmount the current canvas layer, clean up running event states, and mount the targeted project's document graph. This transition must be completed completely client-side in under 100 milliseconds without forcing a web application or browser page reload.
3.5. Local-First Persistence Architecture
Local State Integrity: Workspace content must completely survive runtime crashes, web application refreshes, system restarts, and terminal disconnections. Every data change—whether driven by manual user keyboard input or incoming streamed text—must write down immediately.
CRDT Binary Serialization: The data layer must rely entirely on Conflict-free Replicated Data Type binary trees mapped to localized data storage via the browser's native IndexedDB directory.
Crash Recovery Boot Sequence: Upon application boot, an initialization service must scan the browser storage engine index, identify the most recently active workspace identifier, rebuild the structural data engine from local binary storage logs, and present the workspace exactly as it was left.
3.6. Downstream Agent Execution Hook
Every structural node component or multi-selected group of blocks within the BlockSuite canvas must feature an actionable contextual interaction macro.
When executed, the system must extract the plain text contents, strip out layout wrappers, and dispatch a structured local loopback event to the Node background service.
The Node service must interpret the payload and instantly spawn an asynchronous local system subprocess, invoking the target agent orchestrator command execution array with the text payload passed as a clear functional argument.
4. System Topology & Backend Specifications
4.1. Framework-Agnostic Core Principles
The front-end web interface must treat BlockSuite as a set of standard, browser-native web components. No framework-specific lifecycle boundaries or proprietary wrapper hooks may be utilized for data rendering or view synchronization.
4.2. Local-Only Node Runtime Environment
The background daemon service runs on the Node runtime. Node does not provide an OS-enforced permission model (there is no equivalent of a native `--allow-*` capability flag), so the daemon's security posture is achieved through containment rather than a runtime sandbox: it binds exclusively to the loopback interface (127.0.0.1) so the control channel never leaves the local machine, keeps its spawn surface restricted to the explicitly configured agent harness, and path-traversal-guards any static file serving. For stricter isolation, operators are expected to run the daemon under an OS-level boundary (a restricted user account or container).
The Node backend is responsible for spawning pseudo-terminal instances — via @lydell/node-pty (real ConPTY/forkpty) — that attach to local terminal execution binaries or running system sessions.
The backend must establish a local, low-overhead WebSocket server loop to broadcast the raw pseudo-terminal standard output data directly to the web client, running entirely within a local-only sandbox environment.
5. Non-Functional Requirements & Performance Targets
5.1. Framerate-Throttled UI Updates
To prevent the interface from locking or crashing under rapid terminal text output, the streaming engine must decouple network transmission speeds from visual DOM rendering operations.
The system must use a double-buffering model combined with browser animation frame rendering loops. Text inputs must accumulate in a virtual block buffer, and visual block changes must be throttled to execute strictly on active browser paint cycles. This prevents the document store from being flooded with successive micro-mutations while keeping user interaction rendering fluid.
Modern Angular signals and reactivity concepts must be used as well as Angular 22 uses OnPush change detection by default.
5.2. Memory Management Safety
The application must actively monitor open workspace instances. Switching projects via the navigation sidebar must explicitly clear current cache allocations, tear down active WebSocket listeners, and terminate unneeded object maps to maintain long-term system stability during continuous engineering sessions.

