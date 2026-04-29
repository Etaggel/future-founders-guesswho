# Future Founders Face Game

Web game to learn attendee names, faces, and conversation facts before Dogpatch Future Founders 2026.

## Features

- Learn mode in batches of 3 attendees (always includes weak/unmastered profiles)
- Play mode
  - Easy: multiple-choice name recognition
  - Hard: free-text recall + reveal
- Facts challenge: choose the two true facts from three options (one lie)
- Pairs mode: select all faces matching a category prompt
- Local progress and score tracking (Cognito + DynamoDB scaffolding included)

## Project Layout

- `web`: Next.js frontend (static export)
- `infra`: AWS CDK stack (Cognito, API, DynamoDB, CloudFront, Route53)
- `lambda`: backend API lambda handler
- `attendees.json`: source attendee research data

## Local Run

```bash
cd web
npm ci
npm run dev
```

Open `http://localhost:3000`.

## Deploy With CDK

```bash
cd infra
npm ci
npx cdk synth
npx cdk deploy --all
```

## Google Login Setup (Cognito)

1. In Google Cloud Console, create OAuth client credentials.
2. Set authorized origin to `https://founders.legg.ie`.
3. Set redirect URI to `https://<cognito-domain>/oauth2/idpresponse`.
4. Replace placeholders in `infra/lib/ff-game-stack.ts`:
   - `TODO_GOOGLE_CLIENT_ID`
   - `TODO_GOOGLE_CLIENT_SECRET`
5. Deploy infra.

Recommended hardening: move Google credentials to AWS Secrets Manager and read via CDK secret references.

## Identity Confidence Flags

Attendees with confidence below `0.75` are flagged in Learn Mode as “identity not fully confirmed.”
Current unresolved IDs from dataset are expected to include IDs with low confidence and missing LinkedIn URLs.
