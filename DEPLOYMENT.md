# Deployment

## Environment variables

NODE_ENV=production
PORT=10000
DATABASE_URL=<hosted PostgreSQL connection string>
SESSION_SECRET=<32+ character random secret>
ADMIN_NAME=<administrator name>
ADMIN_EMAIL=<administrator email>
ADMIN_PASSWORD=<administrator password>
APP_ORIGIN=<public https URL>
SEED_DEMO_USERS=false

## Render-style deployment

- Create a PostgreSQL database.
- Create a Node web service from this repository.
- Build command: `npm install`
- Start command: `npm start`
- Add the environment variables above.
- Deploy and open the generated HTTPS URL.

For a custom domain, point the domain's DNS records to the hosting provider and set `APP_ORIGIN` to the final HTTPS address.

## Security notes

- Public registration is not implemented.
- User accounts are created only through the Coordinator / Administrator endpoint.
- Passwords are stored as bcrypt hashes.
- Session cookies are HTTP-only and secure in production.
- Privileged API routes enforce role authorization server-side.
- Do not expose PostgreSQL credentials in frontend files.
