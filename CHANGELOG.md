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
