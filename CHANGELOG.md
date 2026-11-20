## 2026-11-20 – Project form copy and system flowchart
- Removed the extra group-size explanation from the Add Project helper text and validation message; unlimited multi-student selection remains unchanged.
- Rebuilt the system flowchart to start with Coordinator/Administrator account creation and role assignment, then follow login, project assignment, defense request, review, scheduling, conflict validation, defense outcome, evaluation, and Coordinator reporting.
- Removed the parallel Weekly Tracker/WBS/Gantt progress branch from the flowchart only; those separate project-management features remain part of the application.
- Put process descriptions inside their flowchart shapes and added a dedicated legend for symbols, flow direction, and role/system colors.
- Added PNG, SVG, and Mermaid source files under `docs/`; the PNG and SVG are also available under `public/assets/`.

## 2026-11-20 – Unlimited students per project
- Removed the three-student maximum from project creation in both the Coordinator interface and the server API.
- Replaced the modifier-key multi-select with a searchable checkbox list so Coordinators can select any number of unassigned students without holding Ctrl/Command.
- Added a live selected-student count and retained disabled entries for students already assigned to another project.
- Kept server-side duplicate-assignment checks and transactional creation for every selected student.
- No database migration is required; the existing PostgreSQL integer-array field and project-members table support multiple members in one project.

# Changelog

## 2026-11-18 – Project assignment, progress synchronization, and schedule editing
- Prevent project creation when any selected student or adviser is already assigned to an existing project. The check runs in the UI and again inside a database transaction on the server to prevent concurrent duplicate assignments.
- Show already-assigned students and advisers as unavailable in the project creation form, with the project they belong to.
- Make Weekly Tracker records the source of truth for linked WBS and Gantt statuses and progress. Changes to a weekly status are reflected when the Project Plan is reloaded.
- Show aggregate status and progress columns in the Gantt Chart.
- Remove the separate Change Room / Assign Room action from Defense Scheduling. Room changes are made through Edit schedule, which retains room availability and conflict validation.
- Preserve the PostgreSQL DATE parser fix so date-only defense request dates do not shift by one day across time zones.


# Defense Request completion feedback fix

- When a defense schedule is `Completed`, the linked defense request is now forced to `Completed`.
- Its feedback is also forced to `Defense completed.` so old values such as `Approved for scheduling.` cannot remain after completion.
- The synchronization remains idempotent and runs when defense requests/dashboard data are loaded.

# Main coordinator account protection

- Added a persistent `is_primary_coordinator` marker and automatic migration for existing databases.
- Protected the main Coordinator / Administrator from deactivation, deletion, and edits through User Management.
- Hid destructive controls for the main coordinator in the User Management screen while leaving an Activate action available if the account was already inactive.
- Added server-side checks so the protection also applies to direct API requests.

## Room capacity management
- Added a positive-integer capacity field to room creation and editing, with a default of 30 people for existing rooms.
- Displayed room capacity in Room Management and room selectors used by defense scheduling.
- Added a safe database migration that preserves capacity instead of dropping the column at startup.


# Defense outcome and adviser project-phase clarity

- Added automatic schedule display states using Philippine time: Upcoming, Ongoing, Pending Confirmation, Pending Evaluation, Not Conducted, Reschedule Requested, and the existing Completed/Cancelled states.
- Added panel-member post-defense actions to confirm that an elapsed defense was conducted or report that it was not conducted.
- Evaluations are now available only after the scheduled end time and a Conducted confirmation (historical completed records remain accessible).
- Coordinator schedule screens show the panel outcome report; a Not Conducted schedule can be edited to a new future slot, which resets its previous panel confirmation.
- Student, adviser, panel-member, and coordinator schedule views use the same computed defense status rather than leaving past Upcoming schedules unchanged.
- Reworked the Adviser dashboard project panel to label the coordinator-set project status as a development phase, show its meaning, and display the phase sequence without inventing a numeric progress percentage.
- Added idempotent database migration fields for panel outcome, timestamp, and report note.

- Added the deadline-based Overall Project Plan status to the Adviser dashboard (August 12–November 4, 2026), separately from each project's coordinator-managed development phase.
- Corrected adviser dashboard assigned-student totals using project membership records and made the newest expired defense the one surfaced for follow-up.
- Blocked panel reschedule requests after the original defense has started and prevented cancellation from overwriting a completed or panel-confirmed outcome.


# Preferred defense date timezone fix

- Fixed the one-day-earlier preferred defense date shown to Coordinators when reviewing student requests.
- PostgreSQL `DATE` values are now kept as `YYYY-MM-DD` calendar-date strings instead of being parsed as local-midnight JavaScript `Date` objects that can shift during UTC JSON serialization.
- Updated the defense-request API and submit/resubmit responses to return the preferred date in an explicit `YYYY-MM-DD` format.
- Updated date normalization to preserve the local calendar components if a PostgreSQL date is supplied as a JavaScript `Date` by any older code path.


## Adviser dashboard refinement — November 18, 2026
- Removed the overall project-plan timeline summary from the Adviser dashboard's Project progress panel.
- Project progress now lists only the projects assigned to the signed-in adviser, with the associated student names shown on each project card.
- Replaced the legacy narrow-grid student rows with full-width, theme-aware rows to fix the white block, poor contrast, and broken text wrapping in dark mode.
- Added explicit light- and dark-theme styling for the adviser student list and project student labels.


# Automatic scheduling conflict validation

- Removed the separate Conflict Detection sidebar/page because conflicts are checked automatically during coordinator approval, schedule creation, and schedule editing.
- Server-side validation continues to block overlapping assignments involving the project, student, adviser, panel member, or room before a schedule is saved.



## Student defense request protection — November 18, 2026
- Prevent students from submitting a new defense request when their assigned project already has an active, non-cancelled defense schedule.
- Show the existing schedule date, time, and status in the student request flow; disable projects that already have an active defense and disable submission if none are eligible.
- Apply the same check in the server API and to returned-request resubmissions so the rule cannot be bypassed by direct API calls.
- Allow a new request after the current schedule is marked Completed or Cancelled.

## 2026-11-19 — Responsive landing page
- Added a dedicated landing-page responsive stylesheet loaded after the existing theme styles.
- Reworked the landing page to use a content-driven, scroll-safe layout instead of viewport-locked sizing that could clip content on shorter screens.
- Added responsive desktop, laptop/tablet, phone, and small-phone layouts for the header, theme switch, role selector, sign-in form, and footer.
- Switched mobile landing pages to the poster image background instead of rendering the full video background, while preserving the desktop video.
- Preserved existing role selection, login form IDs, theme controls, and backend routes.

## 2026-11-19 — Fixed light appearance
- Removed the landing-page LIGHT/DARK theme selector and the dashboard theme toggle.
- Removed persisted dark-mode switching from the client; old saved theme preferences are cleared on load.
- Set the landing page and application workspace to a consistent light appearance.
- Added light-theme contrast overrides for sidebar navigation, headings, supporting text, cards, tables, buttons, form fields, dialogs, and semantic status badges.
- Removed the landing-page background video and dark scrim so the fixed light login layout remains readable and avoids loading remote media.
- Preserved role-specific accent colors and all authentication/application logic.


## 2026-11-20 — ThesisFlow professional visual redesign
- Reworked the landing page into a responsive split layout with a clearer product identity, role selection, and sign-in panel.
- Added a consistent professional light design system for the shared role-based workspace: navigation, top bar, dashboard metrics, cards, tables, status labels, forms, and dialogs.
- Improved mobile and tablet behavior, including the collapsible sidebar, responsive metric grids, stacked dashboard panels, scrollable tables, and bottom-aligned mobile dialogs.
- Kept the existing Student, Adviser, Panel Member, and Coordinator workflows, API calls, authentication, and database schema unchanged.
- No database migration is required for this presentation-only update.


## 2026-11-20 — Login session persistence fix
- Session cookies now use the request protocol (`secure: 'auto'`) instead of enabling Secure solely from `NODE_ENV`. This supports local HTTP testing even when the environment is set to production, while keeping cookies Secure behind Render HTTPS.
- Login explicitly saves the regenerated PostgreSQL-backed session before returning success, preventing a race with the immediate dashboard request.
- The client verifies `/api/session` before opening the dashboard and shows a clear message if the session was not persisted.


## 2026-11-20 — Login transition and viewport fix

- Fixed the landing-page `display:flex !important` rule overriding the `.hidden` state after successful sign-in.
- `showApp()` now sets the auth shell's `hidden` and accessibility state explicitly and reveals the authenticated app shell.
- Added a final viewport stylesheet so desktop and mobile login pages scroll vertically when content exceeds the viewport.
- Kept the authenticated dashboard on its existing internal scroll layout.
- No database schema or data changes are required.
- Browser layout checks: 1360×640 desktop login page scrolls; 390×667 mobile login page scrolls without horizontal overflow; auth shell computes to `display:none` when hidden.
- Live PostgreSQL and Render account sign-in remain to be verified in the user's environment.


## Scheduling date-entry stability (2026-11-20)

- Replaced editable browser-native date segments in student requests, coordinator scheduling, schedule editing, resubmission, and panel reschedule requests with a consistent numeric `MM/DD/YYYY` input.
- Added input masking that preserves typed month/day digits, validates actual calendar dates (including leap years), and converts to ISO `YYYY-MM-DD` before API calls.
- Kept the database/API date format and existing timezone-safe server normalization unchanged. Read-only panel schedule dates remain display-only.
- No database migration required.


## November 20, 2026 — Scheduling and final defense result workflow

- Documented both Coordinator approval paths: schedule immediately from the student's preferred date/time, or approve first and create the schedule manually later.
- Added per-evaluator `defense_result` storage so each panel member/adviser decision is retained instead of losing it when the last evaluator submits.
- Added `result_status`, final decision note, finalizing Coordinator, and finalization timestamp to schedules.
- All required evaluators must submit before a result can be finalized. If every evaluator selects the same result, the system finalizes it automatically. If they disagree, the Coordinator must review the individual decisions, select the final result, and provide a decision note.
- Added the Coordinator's Final Result Review panel and endpoint; finalized results are locked against later evaluator edits.
- Updated evaluation views and CSV report to distinguish evaluator decisions from the final defense result.
- Updated the system flowchart and documentation to show the two scheduling paths and final-result decision process.
- Existing completed schedules with an already recorded final result are preserved as finalized. Legacy individual evaluations have no recoverable per-evaluator result because the prior version did not store it; those records remain visible and are not rewritten.


## 2026-11-20 – Final defense result workflow hardening

- Store each evaluator's decision independently; the last submitted decision can no longer overwrite the final defense result.
- Automatically finalize when every explicitly assigned evaluator agrees; conflicting decisions require a documented Coordinator decision.
- Count only members actually assigned in Panel Assignment as required evaluators. The Adviser is optional and is required only when explicitly assigned to the defense.
- Prevent panel assignments from being added or removed after the defense outcome is recorded or the final result is finalized.
- Lock the panel roster in the Coordinator interface after the defense outcome is recorded.
- Update the system flowchart to show both Coordinator scheduling paths, optional Adviser evaluation, result agreement/disagreement handling, and the evaluator-roster lock.
## Flowchart update
- Replaced the previous generated flowchart with the exact owner-approved diagram, starting from account creation and covering the complete defense workflow.
- Updated the Coordinator Project Plan page image and flowchart documentation; removed superseded alternate diagram sources to avoid inconsistent versions.
