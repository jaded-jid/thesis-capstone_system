# A Thesis and Capstone Defense Scheduling and Panel Management System

This is the redesigned full-stack implementation of the thesis/capstone defense scheduling and panel management project.

## Core workflows
- Coordinator / Administrator manages users, projects, defense requests, schedules, rooms, panels, evaluations, and reports.
- Student submits a proposal/final defense request using an assigned project, preferred date, and preferred time.
- Adviser or Coordinator can approve a pending request; approval automatically creates the schedule from the student's requested date/time.
- A Coordinator may also create or edit a defense schedule manually.
- Panel members are assigned to an existing defense schedule; date/time are always inherited from that schedule.
- Panel members may proceed or request a reschedule. An approved reschedule updates the existing defense schedule to the requested date/time.
- Evaluations record scores, recommendation, comments, and a formal defense result. The defense becomes completed after all assigned evaluators submit.
- Students can request result clarification; advisers can resolve the clarification with a response.

## Project management records
The Coordinator has access to the supplied WBS, Gantt Chart, Budget Plan, Risk Register, System Flowchart, and Weekly Tracker. The seed data follows the submitted project documents; the weekly tracker starts with Weeks 1–4 completed.

## Security and account model
- There is no public registration endpoint.
- Accounts are created by the Coordinator / Administrator only.
- Normal users cannot change their name or email.
- Coordinators can update user name, email, role, password, and panel availability.
- Important actions are recorded in an audit log.

## Local setup
1. Create a PostgreSQL database named `thesis`.
2. Copy `.env.example` to `.env` and fill in your PostgreSQL credentials and a strong session secret.
3. Run `npm install`.
4. Run `npm start`.
5. Open `http://localhost:10000`.

The app initializes and migrates the schema on startup.
