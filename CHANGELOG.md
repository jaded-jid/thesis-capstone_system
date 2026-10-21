<<<<<<< HEAD
# Coordinator Conflict Detection

- Added a coordinator-only Conflict Detection page in the sidebar and a shortcut from Defense Scheduling.
- Added a protected `/api/schedule-conflicts` endpoint that scans upcoming schedules for overlapping projects, students, advisers, panel members, and rooms.
- The page displays each conflicting schedule pair, overlap time, affected resource, summary counts, and a refresh action. Cancelled and completed defenses are excluded.
- Existing schedule-create and schedule-update conflict validation remains in place.

=======
>>>>>>> 5385c8a821f0706fb7b3125ed592c5093110853e
# Defense Request completion feedback fix

- When a defense schedule is `Completed`, the linked defense request is now forced to `Completed`.
- Its feedback is also forced to `Defense completed.` so old values such as `Approved for scheduling.` cannot remain after completion.
- The synchronization remains idempotent and runs when defense requests/dashboard data are loaded.
<<<<<<< HEAD

# Main coordinator account protection

- Added a persistent `is_primary_coordinator` marker and automatic migration for existing databases.
- Protected the main Coordinator / Administrator from deactivation, deletion, and edits through User Management.
- Hid destructive controls for the main coordinator in the User Management screen while leaving an Activate action available if the account was already inactive.
- Added server-side checks so the protection also applies to direct API requests.
=======
>>>>>>> 5385c8a821f0706fb7b3125ed592c5093110853e
