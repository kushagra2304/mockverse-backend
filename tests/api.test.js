// tests/api.test.js
import { test, describe, before, after } from "node:test";
import assert from "node:assert/strict";
import http from "node:http";
import bcrypt from "bcryptjs";
import app, { setDb, setModel, setJudge0Runner } from "../server.js";

let server;
let baseUrl;

// In-memory mock database for testing
class MockDatabase {
  constructor() {
    this.users = [];
    this.sessions = [];
    this.attempts = [];
    this.responses = [];
    this.nextUserId = 1;
    this.nextSessionId = 1;
    this.nextAttemptId = 1;
    this.nextResponseId = 1;
  }

  async query(sql, params = []) {
    const trimmed = sql.trim();

    // SELECT 1 (connectivity check)
    if (trimmed.startsWith("SELECT 1")) {
      return [[{ 1: 1 }]];
    }

    // CREATE TABLE checks
    if (trimmed.startsWith("CREATE TABLE")) {
      return [{ affectedRows: 0 }];
    }

    // Users duplicate check / find by email
    if (trimmed.includes("FROM users WHERE LOWER(email) = LOWER(?)")) {
      const email = String(params[0]).toLowerCase();
      const match = this.users.find((u) => u.email.toLowerCase() === email);
      return [match ? [match] : []];
    }

    // Insert user
    if (trimmed.includes("INSERT INTO users")) {
      const [name, email, password] = params;
      const newUser = {
        id: this.nextUserId++,
        name,
        email,
        password,
        created_at: new Date().toISOString(),
      };
      this.users.push(newUser);
      return [{ insertId: newUser.id, affectedRows: 1 }];
    }

    // Update user password (upgrade)
    if (trimmed.includes("UPDATE users SET password = ? WHERE id = ?")) {
      const [newHash, id] = params;
      const user = this.users.find((u) => u.id === id);
      if (user) user.password = newHash;
      return [{ affectedRows: 1 }];
    }

    // Get user by id (/api/me)
    if (trimmed.includes("FROM users WHERE id = ?")) {
      const id = params[0];
      const match = this.users.find((u) => u.id === id);
      return [match ? [match] : []];
    }

    // Insert interview session
    if (trimmed.includes("INSERT INTO interview_sessions")) {
      const [session_id, user_id] = params;
      const newSession = {
        id: this.nextSessionId++,
        session_id,
        user_id,
        topic: null,
        difficulty: null,
        started_at: new Date().toISOString(),
      };
      this.sessions.push(newSession);
      return [{ insertId: newSession.id, affectedRows: 1 }];
    }

    // Update interview session
    if (trimmed.includes("UPDATE interview_sessions SET topic = ?, difficulty = ? WHERE session_id = ?")) {
      const [topic, difficulty, session_id] = params;
      const session = this.sessions.find((s) => s.session_id === session_id);
      if (session) {
        session.topic = topic;
        session.difficulty = difficulty;
      }
      return [{ affectedRows: session ? 1 : 0 }];
    }

    // Insert attempt
    if (trimmed.includes("INSERT INTO interview_attempts")) {
      const [session_id, user_id, question, user_answer, is_correct] = params;
      const newAttempt = {
        id: this.nextAttemptId++,
        session_id,
        user_id,
        question,
        user_answer,
        is_correct: is_correct ? 1 : 0,
        created_at: new Date().toISOString(),
      };
      this.attempts.push(newAttempt);
      return [{ insertId: newAttempt.id, affectedRows: 1 }];
    }

    // Insert response
    if (trimmed.includes("INSERT INTO interview_responses")) {
      const [user_id, session_id, question, answer, feedback] = params;
      const newResp = {
        id: this.nextResponseId++,
        user_id,
        session_id,
        question,
        answer,
        feedback,
      };
      this.responses.push(newResp);
      return [{ insertId: newResp.id, affectedRows: 1 }];
    }

    // Get score
    if (trimmed.includes("FROM interview_attempts") && trimmed.includes("WHERE session_id = ?")) {
      const sessionId = params[0];
      const matching = this.attempts.filter((a) => a.session_id === sessionId);
      const correct = matching.reduce((acc, curr) => acc + (curr.is_correct ? 1 : 0), 0);
      return [[{ correct, total: matching.length }]];
    }

    return [[]];
  }
}

const mockDb = new MockDatabase();

// Mock Gemini model
const mockGemini = {
  generateContent: async (prompt) => {
    if (prompt.includes("Generate exactly 10 mock interview questions")) {
      return {
        response: {
          text: () => `1. What is an event loop in JavaScript?
2. Explain Closures.
3. What is the difference between let, const, and var?
4. How does prototypical inheritance work?
5. What are Promises and async/await?
6. Describe the Virtual DOM.
7. What are HTTP status codes?
8. What is CSS specificity?
9. Explain REST API principles.
10. How do WebSockets differ from HTTP?`,
        },
      };
    }
    if (prompt.includes("Evaluate the answer strictly based on the question")) {
      return {
        response: {
          text: () => `Is the answer correct? Yes
Good explanation covering the core concept concisely.`,
        },
      };
    }
    return {
      response: {
        text: () => "Mock response",
      },
    };
  },
};

// Mock Judge0 runner
const mockJudge0 = async (languageKey, source, stdin) => {
  if (source.includes("SYNTAX_ERROR")) {
    return {
      stdout: "",
      stderr: "SyntaxError: Unexpected identifier",
      compileStderr: "SyntaxError: Unexpected identifier",
      code: 6,
    };
  }
  return {
    stdout: stdin ? `Output for ${stdin}` : "Hello World\n",
    stderr: "",
    compileStderr: null,
    code: 3,
  };
};

before(async () => {
  setDb(mockDb);
  setModel(mockGemini);
  setJudge0Runner(mockJudge0);

  await new Promise((resolve) => {
    server = http.createServer(app);
    server.listen(0, "127.0.0.1", () => {
      const port = server.address().port;
      baseUrl = `http://127.0.0.1:${port}`;
      resolve();
    });
  });
});

after(async () => {
  if (server) {
    await new Promise((resolve) => server.close(resolve));
  }
});

// Helper for fetch
async function req(path, options = {}) {
  const url = `${baseUrl}${path}`;
  const res = await fetch(url, {
    ...options,
    headers: {
      "Content-Type": "application/json",
      ...(options.headers || {}),
    },
  });
  const data = await res.json().catch(() => ({}));
  return { status: res.status, headers: res.headers, data };
}

describe("MockVerse Backend API Tests", () => {
  test("GET /health returns 200 with status ok and connected flags", async () => {
    const res = await req("/health");
    assert.equal(res.status, 200);
    assert.equal(res.data.status, "ok");
    assert.equal(res.data.database, true);
    assert.equal(res.data.aiConfigured, true);
    assert.equal(typeof res.data.uptime, "number");
  });

  describe("Authentication (/api/signup, /api/login, /api/me)", () => {
    test("POST /api/signup fails with 400 on missing fields", async () => {
      const res = await req("/api/signup", {
        method: "POST",
        body: JSON.stringify({ name: "Alice" }),
      });
      assert.equal(res.status, 400);
      assert.match(res.data.error, /required/i);
    });

    test("POST /api/signup fails with 400 on invalid email", async () => {
      const res = await req("/api/signup", {
        method: "POST",
        body: JSON.stringify({
          name: "Alice",
          email: "not-an-email",
          password: "password123",
        }),
      });
      assert.equal(res.status, 400);
      assert.match(res.data.error, /invalid email/i);
    });

    test("POST /api/signup fails with 400 on password < 6 chars", async () => {
      const res = await req("/api/signup", {
        method: "POST",
        body: JSON.stringify({
          name: "Alice",
          email: "alice@test.com",
          password: "123",
        }),
      });
      assert.equal(res.status, 400);
      assert.match(res.data.error, /at least 6 characters/i);
    });

    test("POST /api/signup creates new user successfully (201)", async () => {
      const res = await req("/api/signup", {
        method: "POST",
        body: JSON.stringify({
          name: "Alice Developer",
          email: "alice@test.com",
          password: "securePassword123",
        }),
      });
      assert.equal(res.status, 201);
      assert.equal(res.data.success, true);
    });

    test("POST /api/signup prevents duplicate accounts with 409 Conflict", async () => {
      const res = await req("/api/signup", {
        method: "POST",
        body: JSON.stringify({
          name: "Alice Again",
          email: "alice@test.com",
          password: "securePassword123",
        }),
      });
      assert.equal(res.status, 409);
      assert.match(res.data.error, /already exists/i);
    });

    test("POST /api/login fails on wrong credentials", async () => {
      const res = await req("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: "alice@test.com",
          password: "wrongpassword",
        }),
      });
      assert.equal(res.status, 401);
    });

    let authToken;
    let userId;

    test("POST /api/login succeeds with correct password and returns JWT token", async () => {
      const res = await req("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: "alice@test.com",
          password: "securePassword123",
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);
      assert.ok(res.data.token);
      assert.equal(res.data.user.email, "alice@test.com");
      authToken = res.data.token;
      userId = res.data.user.id;
    });

    test("GET /api/me fails without token (401)", async () => {
      const res = await req("/api/me");
      assert.equal(res.status, 401);
    });

    test("GET /api/me succeeds with valid Bearer token", async () => {
      const res = await req("/api/me", {
        headers: {
          Authorization: `Bearer ${authToken}`,
        },
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.user.email, "alice@test.com");
    });

    test("POST /api/login upgrades legacy plaintext password seamlessly", async () => {
      // Insert legacy user with plain text password
      mockDb.users.push({
        id: mockDb.nextUserId++,
        name: "Legacy Bob",
        email: "bob@legacy.com",
        password: "legacyPlainTextPassword",
        created_at: new Date().toISOString(),
      });

      const res = await req("/api/login", {
        method: "POST",
        body: JSON.stringify({
          email: "bob@legacy.com",
          password: "legacyPlainTextPassword",
        }),
      });

      assert.equal(res.status, 200);
      assert.equal(res.data.success, true);

      // Verify password in DB was upgraded to bcrypt hash
      const bob = mockDb.users.find((u) => u.email === "bob@legacy.com");
      assert.ok(bob.password.startsWith("$2"));
      const isMatch = await bcrypt.compare("legacyPlainTextPassword", bob.password);
      assert.equal(isMatch, true);
    });
  });

  describe("Interview Endpoints", () => {
    let testSessionId;

    test("POST /interview/start creates a session and returns sessionId", async () => {
      const res = await req("/interview/start", {
        method: "POST",
        body: JSON.stringify({ user_id: 1 }),
      });
      assert.equal(res.status, 200);
      assert.ok(res.data.sessionId);
      testSessionId = res.data.sessionId;
    });

    test("POST /start-interview validates topic and difficulty", async () => {
      const res = await req("/start-interview", {
        method: "POST",
        body: JSON.stringify({ topic: "React", difficulty: "invalid-diff" }),
      });
      assert.equal(res.status, 400);
    });

    test("POST /start-interview generates 10 questions and returns sessionId", async () => {
      const res = await req("/start-interview", {
        method: "POST",
        body: JSON.stringify({
          topic: "JavaScript",
          difficulty: "medium",
          session_id: testSessionId,
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.questions.length, 10);
      assert.equal(res.data.sessionId, testSessionId);
      assert.equal(res.data.interview_id, testSessionId);
    });

    test("POST /check-answer evaluates answer correctly", async () => {
      const res = await req("/check-answer", {
        method: "POST",
        body: JSON.stringify({
          question: "What is closure?",
          answer: "A closure is a function with access to its outer scope.",
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.is_correct, 1);
      assert.ok(res.data.feedback);
    });

    test("POST /interview/save-answer records user attempt", async () => {
      const res = await req("/interview/save-answer", {
        method: "POST",
        body: JSON.stringify({
          session_id: testSessionId,
          user_id: 1,
          question: "What is closure?",
          user_answer: "A closure is a function bundled with its lexical environment.",
          is_correct: 1,
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.message, "Attempt saved");
    });

    test("POST /save-interview-response saves complete response with feedback", async () => {
      const res = await req("/save-interview-response", {
        method: "POST",
        body: JSON.stringify({
          sessionId: testSessionId,
          userId: 1,
          question: "What is closure?",
          answer: "My answer",
          feedback: "Great job",
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.message, "Saved successfully");
    });

    test("GET /interview/score/:sessionId returns correct calculation", async () => {
      const res = await req(`/interview/score/${testSessionId}`);
      assert.equal(res.status, 200);
      assert.equal(res.data.correct, 1);
      assert.equal(res.data.total, 1);
    });
  });

  describe("Code Execution Endpoints (/execute, /run-tests)", () => {
    test("POST /execute validates required language and source", async () => {
      const res = await req("/execute", {
        method: "POST",
        body: JSON.stringify({ language: "javascript" }),
      });
      assert.equal(res.status, 400);
    });

    test("POST /execute rejects unsupported languages", async () => {
      const res = await req("/execute", {
        method: "POST",
        body: JSON.stringify({ language: "ruby", source: "puts 1" }),
      });
      assert.equal(res.status, 400);
      assert.match(res.data.error, /unsupported language/i);
    });

    test("POST /execute executes code successfully via runner", async () => {
      const res = await req("/execute", {
        method: "POST",
        body: JSON.stringify({
          language: "javascript",
          source: 'console.log("Hello World")',
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.code, 3);
      assert.equal(res.data.stdout, "Hello World\n");
    });

    test("POST /run-tests executes test cases and reports passes", async () => {
      const res = await req("/run-tests", {
        method: "POST",
        body: JSON.stringify({
          language: "javascript",
          source: 'const readline = require("readline"); ...',
          testCases: [
            { input: "1 2", expectedOutput: "Output for 1 2" },
            { input: "3 4", expectedOutput: "Output for 3 4" },
          ],
        }),
      });
      assert.equal(res.status, 200);
      assert.equal(res.data.totalCount, 2);
      assert.equal(res.data.passedCount, 2);
      assert.equal(res.data.results[0].passed, true);
    });
  });

  describe("General Reliability & Middleware", () => {
    test("Returns 404 on undefined routes", async () => {
      const res = await req("/undefined-endpoint-xyz");
      assert.equal(res.status, 404);
      assert.match(res.data.error, /route not found/i);
    });

    test("Returns 400 on malformed JSON payload", async () => {
      const url = `${baseUrl}/api/login`;
      const res = await fetch(url, {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: "INVALID_JSON{",
      });
      const data = await res.json();
      assert.equal(res.status, 400);
      assert.match(data.error, /malformed json/i);
    });
  });
});
