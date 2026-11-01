# MockVerse Backend

MockVerse is an AI-powered technical interview preparation and code execution platform. The backend provides secure authentication, Gemini-powered question generation and evaluation, MySQL session and performance persistence, and sandboxed code execution via Judge0.

---

## Features

- **Authentication & Security:**
  - Salted password hashing with bcrypt (12 rounds)
  - Signed JSON Web Tokens (JWT) with 7-day expiration
  - Automated transparent migration for legacy plain-text passwords
  - Rate limiting on authentication, AI generation, and code execution endpoints
  - Safe error handling preventing secret or stack trace leakage
- **AI Interview Engine:**
  - Generates 10 structured technical interview questions using Google Gemini 2.0 Flash
  - Real-time answer evaluation, feedback generation, and correctness detection
  - Quota management and rate limit safeguards
- **Code Execution:**
  - Secure sandboxed execution for JavaScript, Python, and C++ via Judge0 CE RapidAPI
  - Multi-test-case runner comparing expected vs actual stdout
- **Database & Persistence:**
  - MySQL connection pooling with automatic reconnection
  - SSL CA certificate support (Aiven MySQL compatible with `ca.pem`)
  - Automated schema initialization (`users`, `interview_sessions`, `interview_attempts`, `interview_responses`)
- **Developer Experience:**
  - Native automated test suite with Node.js test runner (`npm test`)
  - Full end-to-end integration with `mockverse-frontend`

---

## Tech Stack

- **Runtime:** Node.js (ES Modules, `type: module`)
- **Web Framework:** Express 5
- **Database:** MySQL 8 (`mysql2/promise`)
- **AI Model:** Google Gemini 2.0 Flash (`@google/generative-ai`)
- **Code Sandbox:** Judge0 CE via RapidAPI
- **Auth:** `bcryptjs`, `jsonwebtoken`
- **Security:** `cors`, `express-rate-limit`

---

## Prerequisites

- Node.js (v18 or higher recommended; v24 supported)
- MySQL instance (local or managed cloud such as Aiven, AWS RDS, PlanetScale)
- Google Gemini API Key
- RapidAPI Judge0 API Key

---

## Getting Started

### 1. Installation

From the `mockverse-backend` directory, install all dependencies:

```bash
npm install
```

### 2. Environment Configuration

Copy the example environment configuration:

```bash
cp .env.example .env
```

Populate `.env` with your credentials:

```ini
PORT=5000
FRONTEND_URL=http://localhost:5173
JWT_SECRET=your_super_secret_jwt_key_here

# MySQL Configuration
DB_HOST=your-mysql-host.aivencloud.com
DB_USER=avnadmin
DB_PASSWORD=your_database_password
DB_NAME=defaultdb
DB_PORT=3306
DB_SSL=true
DB_SSL_REJECT_UNAUTHORIZED=false

# Google Gemini API Key
# Get key: https://aistudio.google.com/app/apikey
GEMINI_API_KEY=your_gemini_api_key_here

# Judge0 RapidAPI Key
# Subscribe: https://rapidapi.com/judge0-official/api/judge0-ce
JUDGE0_API_KEY=your_rapidapi_judge0_api_key_here
JUDGE0_HOST=judge0-ce.p.rapidapi.com
```

### 3. Database Initialization

The database schema is created automatically on server boot! The following tables are automatically initialized:
- `users`: stores registered candidates and hashed credentials.
- `interview_sessions`: records created interview sessions with topic and difficulty.
- `interview_attempts`: records individual question responses and binary pass/fail flags.
- `interview_responses`: stores full responses with Gemini feedback.

### 4. Running the Server

Start in production mode:
```bash
npm start
```

Start in development mode with hot reload:
```bash
npm run dev
```

The server will be accessible at `http://localhost:5000`. Verify with:
```bash
curl http://localhost:5000/health
```

---

## Running Automated Tests

Run the full automated test suite:
```bash
npm test
```

The test suite runs 24 unit and integration tests using Node's built-in test runner without requiring live database or paid API credentials.

---

## Connecting with Frontend

1. Ensure the backend is running at `http://localhost:5000`.
2. In `mockverse-frontend`, install dependencies and run:
   ```bash
   cd ../mockverse-frontend
   npm install
   npm run dev
   ```
3. Open `http://localhost:5173` in your browser. All authentication, interview setup, video interview, scoring, and LeetCode solve workflows will seamlessly connect to the local backend.
