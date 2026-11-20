# ThesisFlow System Process Flowchart

This is the high-resolution ThesisFlow System Process Flowchart. The PNG version is displayed in the Coordinator's Project Plan page and included in this documentation folder. A scalable SVG version is also provided for clear viewing at any zoom level.

## Workflow shown

1. **Account creation** — Coordinator/Administrator creates student, adviser and panel-member accounts and assigns roles.
2. **Login** — All users enter their email and password. Invalid credentials return the user to the login form; valid credentials open the appropriate role-based dashboard.
3. **Project setup** — Coordinator creates a Thesis or Capstone project, selects multiple students and one adviser.
4. **Project validation** — System checks account roles, active status and existing student/adviser assignments. Ineligible selections are revised before the project is saved.
5. **Student access and defense request** — Student views the assigned project and submits a Proposal or Final Defense request with preferred date, time and request details.
6. **Request validation and review** — System validates project membership, request details, date/time and existing active requests or schedules. Invalid requests are corrected. Valid requests enter the Coordinator review queue. The Coordinator approves or returns the request with feedback for revision and resubmission.
7. **Defense scheduling** — Coordinator creates the defense schedule, assigns panel members and a room, and the system checks student, adviser, panel-member, room, date and time conflicts. Conflicts are resolved and checked again before the schedule is saved and published.
8. **Rescheduling and defense** — Panel Member views the assigned schedule. A reschedule request goes to the Coordinator for review. Otherwise, the defense is conducted.
9. **Defense outcome** — Panel Member confirms whether the defense was conducted. A Not Conducted outcome is reported to the Coordinator for review and next steps.
10. **Evaluation and result** — Assigned panel members and an adviser when assigned submit evaluations. The system stores each submission and checks whether all required evaluators have submitted. The result remains pending while submissions are incomplete.
11. **Reporting** — The system records the final defense result, the Student views the recorded result, and the Coordinator generates defense-related reports.

## Legend shown in the diagram

- **Oval** — Start / End.
- **Rounded rectangle** — Process / Activity.
- **Diamond** — Decision.
- **Arrow** — Direction of flow.
- **Blue** — Coordinator / Administrator.
- **Green** — Student.
- **Teal** — Adviser.
- **Purple** — Panel Member.
- **Gray** — System.

## Result-finalization note

The diagram shows the high-level result path: the system waits until all required evaluators have submitted before recording the result. The application also preserves each evaluator's decision separately. When all decisions agree, the result can be finalized automatically; when decisions differ, the Coordinator must review the individual evaluations, select the final result and provide an explanation. This safeguard is implemented in the application even though the selected high-level diagram does not draw that additional decision branch.

## Image file

- `system-flowchart.png` — high-resolution flowchart displayed by the Coordinator's Project Plan page.
- `system-flowchart.svg` — scalable vector version for documentation and zoomed viewing.
