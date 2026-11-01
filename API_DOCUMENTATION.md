# MockVerse API Documentation

This document specifies the complete API contract between `mockverse-backend` and `mockverse-frontend`.

**Base URL (Local Development):** `http://localhost:5000`  
**Base URL (Production):** Configurable via `FRONTEND_URL` and `VITE_API_BASE_URL`  

---

## Table of Endpoints

1. [System Health Check (`GET /health`)](#1-system-health-check)
2. [User Registration (`POST /api/signup`)](#2-user-registration)
3. [User Login (`POST /api/login`)](#3-user-login)
4. [Get Current User Profile (`GET /api/me`)](#4-get-current-user-profile)
5. [Start Interview Session (`POST /interview/start`)](#5-start-interview-session)
6. [Generate Interview Questions (`POST /start-interview`)](#6-generate-interview-questions)
7. [Check & Evaluate Answer (`POST /check-answer`)](#7-check--evaluate-answer)
8. [Save Interview Attempt (`POST /interview/save-answer`)](#8-save-interview-attempt)
9. [Save Full Interview Response (`POST /save-interview-response`)](#9-save-full-interview-response)
10. [Get Interview Score (`GET /interview/score/:sessionId`)](#10-get-interview-score)
11. [Execute Code Snippet (`POST /execute`)](#11-execute-code-snippet)
12. [Run Code Test Cases (`POST /run-tests`)](#12-run-code-test-cases)

---

### 1. System Health Check
- **Endpoint:** `GET /health`
- **Purpose:** Verifies that the server is online and inspects subsystem connectivity.
- **Authentication:** None
- **Frontend Caller:** Monitoring scripts / diagnostics
- **Request Parameters / Body:** None
- **Success Response (200 OK):**
  ```json
  {
    "status": "ok",
    "timestamp": "2026-10-26T06:38:29.813Z",
    "uptime": 124,
    "database": true,
    "aiConfigured": true,
    "judge0Configured": true
  }
  ```

---

### 2. User Registration
- **Endpoint:** `POST /api/signup`
- **Purpose:** Registers a new candidate account.
- **Authentication:** None (Rate-limited: 30 requests / 15 minutes)
- **Frontend Caller:** `mockverse-frontend/src/components/signup.jsx`
- **Database Operations:**
  - `SELECT id FROM users WHERE LOWER(email) = LOWER(?)`
  - `INSERT INTO users (name, email, password, created_at) VALUES (?, ?, ?, NOW())`
- **Request Body (JSON):**
  ```json
  {
    "name": "Jane Doe",
    "email": "jane@example.com",
    "password": "securePassword123"
  }
  ```
- **Success Response (201 Created):**
  ```json
  {
    "success": true,
    "message": "Account created successfully!"
  }
  ```
- **Error Responses:**
  - `400 Bad Request`: Missing fields, invalid email format, or password < 6 characters.
  - `409 Conflict`: `{"error": "An account with this email already exists."}`
  - `503 Service Unavailable`: Database not connected.

---

### 3. User Login
- **Endpoint:** `POST /api/login`
- **Purpose:** Authenticates user credentials and generates a signed JWT token.
- **Authentication:** None (Rate-limited: 30 requests / 15 minutes)
- **Frontend Caller:** `mockverse-frontend/src/components/login.jsx`
- **Database Operations:**
  - `SELECT id, name, email, password FROM users WHERE LOWER(email) = LOWER(?)`
  - If password is legacy plain-text, automatically runs `UPDATE users SET password = ? WHERE id = ?`.
- **Request Body (JSON):**
  ```json
  {
    "email": "jane@example.com",
    "password": "securePassword123"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "success": true,
    "message": "Login successful!",
    "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9...",
    "user": {
      "id": 1,
      "name": "Jane Doe",
      "email": "jane@example.com",
      "token": "eyJhbGciOiJIUzI1NiIsInR5cCI6IkpXVCJ9..."
    }
  }
  ```
- **Error Responses:**
  - `400 Bad Request`: Email and password are required.
  - `401 Unauthorized`: `{"error": "Invalid email or password."}`
  - `503 Service Unavailable`: Database not connected.

---

### 4. Get Current User Profile
- **Endpoint:** `GET /api/me`
- **Purpose:** Retrieves the authenticated user's profile details.
- **Authentication:** `Bearer <token>` in `Authorization` header
- **Database Operations:**
  - `SELECT id, name, email, created_at FROM users WHERE id = ?`
- **Success Response (200 OK):**
  ```json
  {
    "user": {
      "id": 1,
      "name": "Jane Doe",
      "email": "jane@example.com",
      "created_at": "2026-10-26T06:00:00.000Z"
    }
  }
  ```
- **Error Responses:**
  - `401 Unauthorized`: No token provided or token invalid/expired.
  - `404 Not Found`: User no longer exists.

---

### 5. Start Interview Session
- **Endpoint:** `POST /interview/start`
- **Purpose:** Initializes a unique interview session identifier.
- **Authentication:** Bearer token (optional) or `user_id` in request body
- **Frontend Caller:** `mockverse-frontend/src/components/setup.jsx`, `setup1.jsx`
- **Database Operations:**
  - `INSERT INTO interview_sessions (session_id, user_id, started_at) VALUES (?, ?, NOW())`
- **Request Body (JSON):**
  ```json
  {
    "user_id": 1
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "sessionId": "4bbd9124-4f01-49b4-b0cf-5b72e519e49c"
  }
  ```
- **Error Responses:**
  - `400 Bad Request`: `user_id` missing.
  - `503 Service Unavailable`: Database not connected.

---

### 6. Generate Interview Questions
- **Endpoint:** `POST /start-interview`
- **Purpose:** Prompts Google Gemini to produce 10 technical interview questions tailored to the requested topic and difficulty.
- **Authentication:** Rate-limited (30 requests / 1 minute)
- **Frontend Caller:** `mockverse-frontend/src/components/setup.jsx`, `setup1.jsx`
- **Database Operations:**
  - Updates `interview_sessions SET topic = ?, difficulty = ? WHERE session_id = ?` (if `session_id` provided).
- **Request Body (JSON):**
  ```json
  {
    "user_id": 1,
    "topic": "React.js",
    "difficulty": "medium",
    "session_id": "4bbd9124-4f01-49b4-b0cf-5b72e519e49c"
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "questions": [
      "Explain the difference between useMemo and useCallback.",
      "How does the React Fiber reconciler prioritize updates?",
      "..."
    ],
    "sessionId": "4bbd9124-4f01-49b4-b0cf-5b72e519e49c",
    "interview_id": "4bbd9124-4f01-49b4-b0cf-5b72e519e49c"
  }
  ```
- **Error Responses:**
  - `400 Bad Request`: Topic or difficulty missing; difficulty must be `easy`, `medium`, or `hard`.
  - `429 Too Many Requests`: AI quota exceeded.
  - `503 Service Unavailable`: `GEMINI_API_KEY` missing.

---

### 7. Check & Evaluate Answer
- **Endpoint:** `POST /check-answer`
- **Purpose:** Submits a candidate's voice transcript/written answer to Gemini for immediate correctness assessment and feedback.
- **Authentication:** Rate-limited (30 requests / 1 minute)
- **Frontend Caller:** `mockverse-frontend/src/components/videoInterview.jsx`
- **Request Body (JSON):**
  ```json
  {
    "question": "What is a closure in JavaScript?",
    "answer": "A closure is when an inner function preserves access to its outer lexical scope even after the outer function has returned."
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "is_correct": 1,
    "feedback": "Is the answer correct? Yes.\nAccurate and concise definition covering lexical scope."
  }
  ```
- **Error Responses:**
  - `400 Bad Request`: Question or answer empty.
  - `429 Too Many Requests`: AI quota exceeded.
  - `503 Service Unavailable`: `GEMINI_API_KEY` missing.

---

### 8. Save Interview Attempt
- **Endpoint:** `POST /interview/save-answer`
- **Purpose:** Persists each individual question attempt and correctness state.
- **Authentication:** Bearer token (optional) or `user_id` in request body
- **Frontend Caller:** `mockverse-frontend/src/components/videoInterview.jsx`
- **Database Operations:**
  - `INSERT INTO interview_attempts (session_id, user_id, question, user_answer, is_correct, created_at) VALUES (?, ?, ?, ?, ?, NOW())`
- **Request Body (JSON):**
  ```json
  {
    "session_id": "4bbd9124-4f01-49b4-b0cf-5b72e519e49c",
    "user_id": 1,
    "question": "What is a closure?",
    "user_answer": "An inner function accessing outer scope.",
    "is_correct": 1
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "message": "Attempt saved"
  }
  ```

---

### 9. Save Full Interview Response
- **Endpoint:** `POST /save-interview-response`
- **Purpose:** Persists detailed answer and AI feedback record.
- **Authentication:** Bearer token (optional) or `userId` in request body
- **Database Operations:**
  - `INSERT INTO interview_responses (user_id, session_id, question, answer, feedback, created_at) VALUES (?, ?, ?, ?, ?, NOW())`
- **Request Body (JSON):**
  ```json
  {
    "sessionId": "4bbd9124-4f01-49b4-b0cf-5b72e519e49c",
    "userId": 1,
    "question": "What is a closure?",
    "answer": "An inner function accessing outer scope.",
    "feedback": "Great concise explanation."
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "message": "Saved successfully"
  }
  ```

---

### 10. Get Interview Score
- **Endpoint:** `GET /interview/score/:sessionId`
- **Purpose:** Computes the total questions answered and number of correct answers for a completed session.
- **Authentication:** None
- **Frontend Caller:** `mockverse-frontend/src/components/score.jsx`
- **Database Operations:**
  - `SELECT COALESCE(SUM(is_correct), 0) AS correct, COUNT(*) AS total FROM interview_attempts WHERE session_id = ?`
- **Success Response (200 OK):**
  ```json
  {
    "correct": 8,
    "total": 10
  }
  ```
- **Error Responses:**
  - `400 Bad Request`: `sessionId` missing.
  - `503 Service Unavailable`: Database not connected.

---

### 11. Execute Code Snippet
- **Endpoint:** `POST /execute`
- **Purpose:** Compiles and runs arbitrary code securely inside Judge0 CE sandbox via RapidAPI.
- **Authentication:** Rate-limited (20 requests / 1 minute)
- **Frontend Caller:** `mockverse-frontend/src/components/LeetCodeSolve.jsx`
- **Request Body (JSON):**
  ```json
  {
    "language": "javascript",
    "source": "console.log('Hello MockVerse');",
    "stdin": ""
  }
  ```
- **Supported Languages:** `javascript`, `python`, `cpp`
- **Success Response (200 OK):**
  ```json
  {
    "stdout": "Hello MockVerse\n",
    "stderr": "",
    "output": "Hello MockVerse\n",
    "code": 3,
    "signal": null,
    "compileStderr": null
  }
  ```
- **Error Responses:**
  - `400 Bad Request`: Missing language/source, unsupported language, or source > 100KB.
  - `503 Service Unavailable`: `JUDGE0_API_KEY` missing.

---

### 12. Run Code Test Cases
- **Endpoint:** `POST /run-tests`
- **Purpose:** Executes candidate's code against an array of test cases and compares expected vs actual outputs.
- **Authentication:** Rate-limited (20 requests / 1 minute)
- **Frontend Caller:** `mockverse-frontend/src/components/LeetCodeSolve.jsx`
- **Request Body (JSON):**
  ```json
  {
    "language": "python",
    "source": "import sys\nfor line in sys.stdin:\n    print(int(line.strip()) * 2)",
    "testCases": [
      { "input": "2\n", "expectedOutput": "4" },
      { "input": "5\n", "expectedOutput": "10" }
    ]
  }
  ```
- **Success Response (200 OK):**
  ```json
  {
    "results": [
      {
        "input": "2\n",
        "expectedOutput": "4",
        "actualOutput": "4",
        "stderr": null,
        "passed": true
      },
      {
        "input": "5\n",
        "expectedOutput": "10",
        "actualOutput": "10",
        "stderr": null,
        "passed": true
      }
    ],
    "passedCount": 2,
    "totalCount": 2
  }
  ```
