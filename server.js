// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import mysql from "mysql2/promise";
import { v4 as uuidv4 } from "uuid";
import bcrypt from "bcryptjs";
import jwt from "jsonwebtoken";
import rateLimit from "express-rate-limit";
import fs from "fs";
import path from "path";
import { fileURLToPath } from "url";

dotenv.config();

const app = express();
// Default to 5001 to avoid macOS ControlCenter/AirPlay collision on port 5000
const PORT = process.env.PORT || 5001;
const JWT_SECRET = process.env.JWT_SECRET || "changeme-use-a-strong-secret";
const BCRYPT_ROUNDS = 12;

// ─── CORS ───────────────────────────────────────────────────────────────────
const defaultOrigins = [
  "https://mockverse-frontend.vercel.app",
  "http://localhost:5173",
  "http://localhost:5174",
  "http://localhost:3000",
  "http://127.0.0.1:5173",
  "http://127.0.0.1:5174",
];

const allowedOrigins = process.env.FRONTEND_URL
  ? [...defaultOrigins, process.env.FRONTEND_URL]
  : defaultOrigins;

app.use(
  cors({
    origin: function (origin, callback) {
      if (!origin || allowedOrigins.includes(origin)) {
        callback(null, true);
      } else {
        callback(new Error("Not allowed by CORS"));
      }
    },
    credentials: true,
  })
);

app.use(express.json({ limit: "1mb" }));

// Handle malformed JSON error
app.use((err, req, res, next) => {
  if (err instanceof SyntaxError && err.status === 400 && "body" in err) {
    return res.status(400).json({ error: "Malformed JSON payload" });
  }
  next(err);
});

// ─── RATE LIMITERS ──────────────────────────────────────────────────────────
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 30,
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});

const aiLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 30,
  message: { error: "AI rate limit reached, please slow down." },
  standardHeaders: true,
  legacyHeaders: false,
});

const codeLimiter = rateLimit({
  windowMs: 60 * 1000,
  max: 20,
  message: { error: "Code execution rate limit reached." },
  standardHeaders: true,
  legacyHeaders: false,
});

// ─── IN-MEMORY DEMO STORES (used when DB is not yet configured) ─────────────
const memorySessions = new Map();
const memoryAttempts = new Map();

// ─── DATABASE POOL & SCHEMA ──────────────────────────────────────────────────
let db = null;

export function setDb(mockDb) {
  db = mockDb;
}

export function getDb() {
  return db;
}

export async function createTables(database) {
  const targetDb = database || db;
  if (!targetDb) return;

  await targetDb.query(`
    CREATE TABLE IF NOT EXISTS users (
      id           INT          NOT NULL AUTO_INCREMENT,
      name         VARCHAR(255) NOT NULL,
      email        VARCHAR(255) NOT NULL UNIQUE,
      password     VARCHAR(255) NOT NULL,
      created_at   DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_users_email (email)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await targetDb.query(`
    CREATE TABLE IF NOT EXISTS interview_sessions (
      id          INT          NOT NULL AUTO_INCREMENT,
      session_id  VARCHAR(36)  NOT NULL UNIQUE,
      user_id     INT          NOT NULL,
      topic       VARCHAR(255),
      difficulty  VARCHAR(50),
      started_at  DATETIME     NOT NULL DEFAULT CURRENT_TIMESTAMP,
      ended_at    DATETIME,
      PRIMARY KEY (id),
      INDEX idx_sessions_user   (user_id),
      INDEX idx_sessions_sid    (session_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await targetDb.query(`
    CREATE TABLE IF NOT EXISTS interview_attempts (
      id           INT           NOT NULL AUTO_INCREMENT,
      session_id   VARCHAR(36)   NOT NULL,
      user_id      INT           NOT NULL,
      question     TEXT          NOT NULL,
      user_answer  TEXT          NOT NULL,
      is_correct   TINYINT(1)    NOT NULL DEFAULT 0,
      created_at   DATETIME      NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_attempts_session (session_id),
      INDEX idx_attempts_user    (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  await targetDb.query(`
    CREATE TABLE IF NOT EXISTS interview_responses (
      id          INT         NOT NULL AUTO_INCREMENT,
      user_id     INT         NOT NULL,
      session_id  VARCHAR(36) NOT NULL,
      question    TEXT        NOT NULL,
      answer      TEXT        NOT NULL,
      feedback    TEXT,
      created_at  DATETIME    NOT NULL DEFAULT CURRENT_TIMESTAMP,
      PRIMARY KEY (id),
      INDEX idx_responses_session (session_id),
      INDEX idx_responses_user    (user_id)
    ) ENGINE=InnoDB DEFAULT CHARSET=utf8mb4;
  `);

  console.log("✅ Database tables verified / created");
}

export async function initDatabase() {
  if (!process.env.DB_HOST) {
    console.warn("⚠️  DB_HOST is not set — database features will run in demo memory mode until configured.");
    return null;
  }

  try {
    let sslConfig = undefined;
    const caCertPath = process.env.DB_CA_PATH || path.resolve("ca.pem");

    if (process.env.DB_SSL === "true" || process.env.DB_SSL_CA) {
      if (fs.existsSync(caCertPath)) {
        sslConfig = {
          ca: fs.readFileSync(caCertPath),
          rejectUnauthorized: process.env.DB_SSL_REJECT_UNAUTHORIZED === "true",
        };
      } else {
        sslConfig = { rejectUnauthorized: false };
      }
    }

    db = mysql.createPool({
      host: process.env.DB_HOST,
      user: process.env.DB_USER,
      password: process.env.DB_PASSWORD,
      database: process.env.DB_NAME,
      port: parseInt(process.env.DB_PORT || "3306", 10),
      ssl: sslConfig,
      waitForConnections: true,
      connectionLimit: 10,
      queueLimit: 0,
      connectTimeout: 20000,
    });

    await db.query("SELECT 1");
    console.log("✅ Connected to MySQL database pool");

    await createTables(db);
    return db;
  } catch (err) {
    console.error("❌ MySQL connection failed:", err.message);
    db = null;
    return null;
  }
}

function requireDb(res) {
  if (!db) {
    res.status(503).json({
      error: "Database service unavailable. Please check database credentials in .env.",
    });
    return false;
  }
  return true;
}

// ─── GEMINI INTEGRATION ──────────────────────────────────────────────────────
let model = null;

if (process.env.GEMINI_API_KEY) {
  try {
    const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
    model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });
    console.log("✅ Gemini model initialized");
  } catch (err) {
    console.warn("⚠️  Failed to initialize Gemini:", err.message);
  }
} else {
  console.warn("⚠️  GEMINI_API_KEY not set — using smart fallback interview question generator");
}

export function setModel(mockModel) {
  model = mockModel;
}

function getFallbackQuestions(topic, difficulty) {
  return [
    `Can you explain the core architecture and fundamental principles of ${topic}?`,
    `What are the most common performance bottlenecks in ${topic} and how do you resolve them?`,
    `How do you handle asynchronous operations and state management in ${topic}?`,
    `What are best practices for testing and debugging ${topic} applications?`,
    `Explain the lifecycle and resource management considerations when using ${topic}.`,
    `How does ${topic} compare to its closest alternative technologies?`,
    `Can you describe a challenging problem you solved using ${topic} and how you architected the solution?`,
    `What security considerations and vulnerabilities should you protect against in ${topic}?`,
    `How do you structure code for scalability and maintainability in a large-scale ${topic} project?`,
    `What recent features or updates in ${topic} have you adopted and why?`,
  ];
}

// ─── JUDGE0 INTEGRATION ──────────────────────────────────────────────────────
const JUDGE0_HOST = process.env.JUDGE0_HOST || "judge0-ce.p.rapidapi.com";
const JUDGE0_BASE_URL = `https://${JUDGE0_HOST}`;
const JUDGE0_API_KEY = process.env.JUDGE0_API_KEY;

function judge0Headers(extra = {}) {
  return {
    "X-RapidAPI-Key": JUDGE0_API_KEY,
    "X-RapidAPI-Host": JUDGE0_HOST,
    ...extra,
  };
}

let languageIdCachePromise = null;

async function resolveLanguageIds() {
  if (languageIdCachePromise) return languageIdCachePromise;

  languageIdCachePromise = (async () => {
    if (!JUDGE0_API_KEY) {
      throw new Error("JUDGE0_API_KEY is not set. Add it to .env.");
    }

    const response = await fetch(`${JUDGE0_BASE_URL}/languages`, {
      headers: judge0Headers(),
    });

    if (!response.ok) {
      const text = await response.text();
      throw new Error(`Failed to fetch Judge0 languages (${response.status}): ${text}`);
    }

    const languages = await response.json();

    const findId = (predicate, label) => {
      const match = languages.find(predicate);
      if (!match) {
        throw new Error(`Could not find a Judge0 language match for ${label}`);
      }
      return match.id;
    };

    const ids = {
      javascript: findId(
        (l) => l.name.includes("JavaScript") && l.name.includes("Node"),
        "JavaScript (Node.js)"
      ),
      python: findId((l) => l.name.startsWith("Python (3"), "Python 3"),
      cpp: findId((l) => l.name.includes("C++ (GCC"), "C++ (GCC)"),
    };

    console.log("✅ Resolved Judge0 language ids:", ids);
    return ids;
  })();

  languageIdCachePromise.catch(() => {
    languageIdCachePromise = null;
  });

  return languageIdCachePromise;
}

const JUDGE0_ACCEPTED = 3;
const JUDGE0_COMPILE_ERROR = 6;

function decodeBase64(value) {
  return value ? Buffer.from(value, "base64").toString("utf-8") : "";
}

let judge0Runner = async function runOnJudge0(languageKey, source, stdin) {
  const ids = await resolveLanguageIds();
  const languageId = ids[languageKey];
  if (!languageId) {
    throw new Error(`Unsupported language: ${languageKey}`);
  }

  const response = await fetch(
    `${JUDGE0_BASE_URL}/submissions?base64_encoded=true&wait=true`,
    {
      method: "POST",
      headers: judge0Headers({ "content-type": "application/json" }),
      body: JSON.stringify({
        language_id: languageId,
        source_code: Buffer.from(source, "utf-8").toString("base64"),
        stdin: Buffer.from(stdin || "", "utf-8").toString("base64"),
      }),
    }
  );

  if (response.status === 429) {
    throw new Error("Judge0 rate limit reached. Try again later or upgrade your RapidAPI plan.");
  }

  if (!response.ok) {
    const text = await response.text();
    throw new Error(`Judge0 request failed (${response.status}): ${text}`);
  }

  const data = await response.json();

  const stdout = decodeBase64(data.stdout);
  const stderr = decodeBase64(data.stderr);
  const compileOutput = decodeBase64(data.compile_output);
  const statusId = data.status?.id;
  const statusDescription = data.status?.description || "";

  const compileStderr =
    statusId === JUDGE0_COMPILE_ERROR ? compileOutput || statusDescription : null;

  const finalStderr =
    statusId && statusId !== JUDGE0_ACCEPTED && statusId !== JUDGE0_COMPILE_ERROR
      ? [statusDescription, stderr].filter(Boolean).join("\n")
      : stderr;

  return {
    stdout,
    stderr: finalStderr,
    output: stdout || finalStderr,
    code: statusId,
    signal: null,
    compileStderr,
  };
};

export function setJudge0Runner(mockRunner) {
  judge0Runner = mockRunner;
}

// ─── AUTHENTICATION MIDDLEWARE ───────────────────────────────────────────────
export function authenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith("Bearer ")) {
    return res.status(401).json({ error: "Authentication required: no Bearer token provided" });
  }
  const token = authHeader.slice(7);
  try {
    const payload = jwt.verify(token, JWT_SECRET);
    req.userId = payload.id;
    req.userEmail = payload.email;
    next();
  } catch {
    return res.status(401).json({ error: "Invalid or expired token" });
  }
}

export function optionalAuthenticate(req, res, next) {
  const authHeader = req.headers.authorization;
  if (authHeader && authHeader.startsWith("Bearer ")) {
    const token = authHeader.slice(7);
    try {
      const payload = jwt.verify(token, JWT_SECRET);
      req.userId = payload.id;
      req.userEmail = payload.email;
    } catch {
      // Continue without user info
    }
  }
  next();
}

// ─── HEALTH CHECK ────────────────────────────────────────────────────────────
app.get("/health", (_req, res) => {
  res.json({
    status: "ok",
    timestamp: new Date().toISOString(),
    uptime: Math.floor(process.uptime()),
    database: Boolean(db),
    aiConfigured: Boolean(model),
    judge0Configured: Boolean(JUDGE0_API_KEY),
  });
});

// ─── SIGNUP ──────────────────────────────────────────────────────────────────
app.post("/api/signup", authLimiter, async (req, res) => {
  const { name, email, password } = req.body || {};

  if (!name || !email || !password) {
    return res.status(400).json({ error: "Name, email, and password are required." });
  }

  const cleanEmail = String(email).trim().toLowerCase();
  const cleanName = String(name).trim();

  const emailRegex = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
  if (!emailRegex.test(cleanEmail)) {
    return res.status(400).json({ error: "Invalid email format." });
  }

  if (password.length < 6) {
    return res.status(400).json({ error: "Password must be at least 6 characters." });
  }

  if (!requireDb(res)) return;

  try {
    const [existing] = await db.query(
      "SELECT id FROM users WHERE LOWER(email) = LOWER(?)",
      [cleanEmail]
    );

    if (existing && existing.length > 0) {
      return res.status(409).json({ error: "An account with this email already exists." });
    }

    const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);

    await db.query(
      "INSERT INTO users (name, email, password) VALUES (?, ?, ?)",
      [cleanName, cleanEmail, hashed]
    );

    return res.status(201).json({
      success: true,
      message: "Account created successfully!",
    });
  } catch (err) {
    console.error("Signup error:", err.message);
    return res.status(500).json({ error: "Failed to create account" });
  }
});

// ─── LOGIN ───────────────────────────────────────────────────────────────────
app.post("/api/login", authLimiter, async (req, res) => {
  const { email, password } = req.body || {};

  if (!email || !password) {
    return res.status(400).json({ error: "Email and password are required." });
  }

  const cleanEmail = String(email).trim().toLowerCase();

  if (!requireDb(res)) return;

  try {
    const [results] = await db.query(
      "SELECT id, name, email, password FROM users WHERE LOWER(email) = LOWER(?)",
      [cleanEmail]
    );

    if (!results || results.length === 0) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const user = results[0];
    let passwordMatch = false;

    if (user.password.startsWith("$2")) {
      passwordMatch = await bcrypt.compare(password, user.password);
    } else {
      if (user.password === password) {
        passwordMatch = true;
        const hashed = await bcrypt.hash(password, BCRYPT_ROUNDS);
        await db.query("UPDATE users SET password = ? WHERE id = ?", [hashed, user.id]);
        console.log(`🔑 Automatically upgraded password to bcrypt for user ${user.id}`);
      }
    }

    if (!passwordMatch) {
      return res.status(401).json({ error: "Invalid email or password." });
    }

    const token = jwt.sign({ id: user.id, email: user.email }, JWT_SECRET, {
      expiresIn: "7d",
    });

    return res.status(200).json({
      success: true,
      message: "Login successful!",
      token,
      user: {
        id: user.id,
        name: user.name,
        email: user.email,
        token,
      },
    });
  } catch (err) {
    console.error("Login error:", err.message);
    return res.status(500).json({ error: "Internal server error" });
  }
});

// ─── AUTH PROFILE (PROTECTED) ────────────────────────────────────────────────
app.get("/api/me", authenticate, async (req, res) => {
  if (!requireDb(res)) return;

  try {
    const [results] = await db.query(
      "SELECT id, name, email, created_at FROM users WHERE id = ?",
      [req.userId]
    );

    if (!results || results.length === 0) {
      return res.status(404).json({ error: "User not found" });
    }

    res.json({ user: results[0] });
  } catch (err) {
    console.error("Profile fetch error:", err.message);
    res.status(500).json({ error: "Failed to fetch profile" });
  }
});

// ─── INTERVIEW: START SESSION ─────────────────────────────────────────────────
app.post("/interview/start", optionalAuthenticate, async (req, res) => {
  const sessionId = uuidv4();
  const userId = req.userId || req.body?.user_id || 1;

  if (db) {
    try {
      await db.query(
        "INSERT INTO interview_sessions (session_id, user_id, started_at) VALUES (?, ?, NOW())",
        [sessionId, userId]
      );
    } catch (error) {
      console.error("Error creating session in DB:", error.message);
    }
  }

  memorySessions.set(sessionId, { user_id: userId, started_at: new Date() });
  res.json({ sessionId });
});

// ─── INTERVIEW: GENERATE QUESTIONS ───────────────────────────────────────────
app.post("/start-interview", aiLimiter, async (req, res) => {
  const { topic, difficulty, session_id } = req.body || {};

  if (!topic || !difficulty) {
    return res.status(400).json({ error: "Topic and difficulty are required" });
  }

  const allowedDifficulties = ["easy", "medium", "hard"];
  if (!allowedDifficulties.includes(String(difficulty).toLowerCase())) {
    return res.status(400).json({ error: "Difficulty must be easy, medium, or hard" });
  }

  const resolvedSessionId = session_id || uuidv4();

  // If Gemini model is not configured, supply high-quality fallback questions
  if (!model) {
    console.warn(`⚠️ GEMINI_API_KEY not configured. Serving fallback questions for: ${topic}`);
    const questions = getFallbackQuestions(topic, difficulty);

    memorySessions.set(resolvedSessionId, {
      topic,
      difficulty,
      user_id: req.body?.user_id || 1,
    });

    return res.json({
      questions,
      interview_id: resolvedSessionId,
      sessionId: resolvedSessionId,
    });
  }

  try {
    const prompt = `Generate exactly 10 mock interview questions for the topic: "${topic}".
Difficulty level: "${difficulty}" (easy, medium, hard).
Format the response as a numbered list from 1 to 10, with only the question text, no answers.
Do not include any preamble or explanation — only the numbered list.`;

    const result = await model.generateContent(prompt);
    const text = result.response.text();

    const questions = text
      .split(/\n+/)
      .filter((line) => /^\d+\./.test(line.trim()))
      .map((q) => q.replace(/^\d+\.\s*/, "").trim())
      .filter(Boolean);

    if (questions.length === 0) {
      return res.status(502).json({ error: "AI returned an unexpected response format" });
    }

    if (session_id && db) {
      try {
        await db.query(
          "UPDATE interview_sessions SET topic = ?, difficulty = ? WHERE session_id = ?",
          [topic, difficulty, session_id]
        );
      } catch (dbErr) {
        console.warn("Failed to update session metadata:", dbErr.message);
      }
    }

    res.json({
      questions,
      interview_id: resolvedSessionId,
      sessionId: resolvedSessionId,
    });
  } catch (err) {
    console.error("Failed to generate questions with AI:", err.message);
    if (err.message?.includes("quota") || err.message?.includes("429")) {
      // Fallback to offline questions on quota limits so user flow isn't blocked
      console.warn("AI quota reached. Using fallback questions.");
      const questions = getFallbackQuestions(topic, difficulty);
      return res.json({
        questions,
        interview_id: resolvedSessionId,
        sessionId: resolvedSessionId,
      });
    }
    res.status(500).json({ error: "Failed to generate questions", details: err.message });
  }
});

// ─── INTERVIEW: EVALUATE ANSWER ───────────────────────────────────────────────
app.post("/check-answer", aiLimiter, async (req, res) => {
  const { question, answer } = req.body || {};

  if (!question || !answer || !String(answer).trim()) {
    return res.status(400).json({ error: "Question and answer are required" });
  }

  if (!model) {
    const wordCount = String(answer).trim().split(/\s+/).length;
    const is_correct = wordCount >= 5 ? 1 : 0;
    const feedback = is_correct
      ? "Is the answer correct? Yes.\nGood explanation. Covered the primary concepts."
      : "Is the answer correct? No.\nThe answer is too brief. Elaborate further on key technical details.";
    return res.json({ feedback, is_correct });
  }

  try {
    const prompt = `Question: ${question}
Answer: ${answer}

Evaluate the answer strictly based on the question.
- Is the answer correct? (Yes/No)
- If incorrect or incomplete, explain what is missing or needs improvement in 1-2 lines.
- If correct, mention it briefly in 1 line.

Respond in a clear and concise manner.`;

    const result = await model.generateContent(prompt);
    const feedback = result.response.text();

    let is_correct = 0;
    const match = feedback.match(/Is the answer correct\?\s*\(?([Yy]es|[Nn]o)\)?/);
    if (match) {
      is_correct = match[1].toLowerCase() === "yes" ? 1 : 0;
    } else if (/correct:\s*yes/i.test(feedback)) {
      is_correct = 1;
    } else if (/correct:\s*no/i.test(feedback)) {
      is_correct = 0;
    } else if (/^\*\*yes\*\*|^-\s*yes\b/im.test(feedback)) {
      is_correct = 1;
    } else if (/^\*\*no\*\*|^-\s*no\b/im.test(feedback)) {
      is_correct = 0;
    }

    res.json({ feedback, is_correct });
  } catch (err) {
    console.error("Error evaluating answer with AI:", err.message);
    const wordCount = String(answer).trim().split(/\s+/).length;
    const is_correct = wordCount >= 5 ? 1 : 0;
    const feedback = is_correct
      ? "Good technical answer covering relevant concepts."
      : "Answer is incomplete or too short.";
    res.json({ feedback, is_correct });
  }
});

// ─── INTERVIEW: SAVE ATTEMPT ──────────────────────────────────────────────────
app.post("/interview/save-answer", optionalAuthenticate, async (req, res) => {
  const { session_id, question, user_answer, is_correct } = req.body || {};
  const user_id = req.userId || req.body?.user_id || 1;

  if (
    !session_id ||
    !question ||
    !user_answer ||
    typeof is_correct === "undefined"
  ) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (db) {
    try {
      await db.query(
        `INSERT INTO interview_attempts (session_id, user_id, question, user_answer, is_correct, created_at)
         VALUES (?, ?, ?, ?, ?, NOW())`,
        [session_id, user_id, question, user_answer, is_correct ? 1 : 0]
      );
    } catch (err) {
      console.warn("DB save attempt error:", err.message);
    }
  }

  const list = memoryAttempts.get(session_id) || [];
  list.push({ question, user_answer, is_correct: is_correct ? 1 : 0 });
  memoryAttempts.set(session_id, list);

  res.status(200).json({ message: "Attempt saved" });
});

// ─── INTERVIEW: SAVE FULL RESPONSE ───────────────────────────────────────────
app.post("/save-interview-response", optionalAuthenticate, async (req, res) => {
  const { question, answer, feedback, sessionId } = req.body || {};
  const userId = req.userId || req.body?.userId || 1;

  if (!question || !answer || !sessionId) {
    return res.status(400).json({ error: "Missing required fields" });
  }

  if (db) {
    try {
      await db.query(
        "INSERT INTO interview_responses (user_id, session_id, question, answer, feedback, created_at) VALUES (?, ?, ?, ?, ?, NOW())",
        [userId, sessionId, question, answer, feedback || null]
      );
    } catch (error) {
      console.warn("DB save response error:", error.message);
    }
  }

  res.status(200).json({ message: "Saved successfully" });
});

// ─── INTERVIEW: GET SCORE ─────────────────────────────────────────────────────
app.get("/interview/score/:sessionId", async (req, res) => {
  const { sessionId } = req.params;

  if (!sessionId) {
    return res.status(400).json({ error: "sessionId is required" });
  }

  if (db) {
    try {
      const [rows] = await db.query(
        `SELECT
           COALESCE(SUM(is_correct), 0) AS correct,
           COUNT(*)                     AS total
         FROM interview_attempts
         WHERE session_id = ?`,
        [sessionId]
      );
      if (rows && rows.length > 0 && Number(rows[0].total) > 0) {
        return res.json({
          correct: Number(rows[0].correct) || 0,
          total: Number(rows[0].total) || 0,
        });
      }
    } catch (err) {
      console.warn("DB score fetch error:", err.message);
    }
  }

  const list = memoryAttempts.get(sessionId) || [];
  const correct = list.filter((a) => a.is_correct === 1).length;
  res.json({
    correct,
    total: list.length,
  });
});

// ─── CODE EXECUTION ───────────────────────────────────────────────────────────
const ALLOWED_LANGUAGES = ["javascript", "python", "cpp"];

app.post("/execute", codeLimiter, async (req, res) => {
  const { language, source, stdin } = req.body || {};

  if (!language || !source) {
    return res.status(400).json({ error: "language and source are required" });
  }

  if (!ALLOWED_LANGUAGES.includes(language)) {
    return res.status(400).json({
      error: `Unsupported language. Allowed: ${ALLOWED_LANGUAGES.join(", ")}`,
    });
  }

  if (source.length > 100_000) {
    return res.status(400).json({ error: "Source code too large (max 100KB)" });
  }

  if (!JUDGE0_API_KEY && judge0Runner.name === "runOnJudge0") {
    return res.status(503).json({
      error: "Code execution service not configured (missing JUDGE0_API_KEY).",
    });
  }

  try {
    const result = await judge0Runner(language, source, stdin);
    res.json(result);
  } catch (err) {
    console.error("Judge0 execution failed:", err.message);
    res.status(500).json({ error: "Code execution failed", details: err.message });
  }
});

app.post("/run-tests", codeLimiter, async (req, res) => {
  const { language, source, testCases } = req.body || {};

  if (!language || !source || !Array.isArray(testCases)) {
    return res.status(400).json({ error: "language, source, and testCases[] are required" });
  }

  if (!ALLOWED_LANGUAGES.includes(language)) {
    return res.status(400).json({
      error: `Unsupported language. Allowed: ${ALLOWED_LANGUAGES.join(", ")}`,
    });
  }

  if (testCases.length > 20) {
    return res.status(400).json({ error: "Too many test cases (max 20)" });
  }

  if (!JUDGE0_API_KEY && judge0Runner.name === "runOnJudge0") {
    return res.status(503).json({
      error: "Code execution service not configured (missing JUDGE0_API_KEY).",
    });
  }

  try {
    const results = [];
    for (const testCase of testCases) {
      const { stdout, stderr, compileStderr } = await judge0Runner(
        language,
        source,
        testCase.input
      );

      if (compileStderr) {
        return res.json({ compileError: compileStderr, results });
      }

      const actual = stdout.trim();
      const expected = (testCase.expectedOutput || "").trim();

      results.push({
        input: testCase.input,
        expectedOutput: expected,
        actualOutput: actual,
        stderr: stderr || null,
        passed: actual === expected,
      });
    }

    const passedCount = results.filter((r) => r.passed).length;
    res.json({ results, passedCount, totalCount: results.length });
  } catch (err) {
    console.error("Test run failed:", err.message);
    res.status(500).json({ error: "Test run failed", details: err.message });
  }
});

// ─── CATCH-ALL 404 ────────────────────────────────────────────────────────────
app.use((_req, res) => {
  res.status(404).json({ error: "Route not found" });
});

// ─── GLOBAL ERROR HANDLER ─────────────────────────────────────────────────────
// eslint-disable-next-line no-unused-vars
app.use((err, _req, res, _next) => {
  console.error("Unhandled error:", err.message);
  res.status(500).json({ error: "Internal server error" });
});

// ─── SERVER STARTUP ───────────────────────────────────────────────────────────
const isDirectExecution =
  process.argv[1] &&
  fileURLToPath(import.meta.url) === path.resolve(process.argv[1]);

if (isDirectExecution && process.env.NODE_ENV !== "test") {
  initDatabase().finally(() => {
    app.listen(PORT, () => {
      console.log(`🚀 MockVerse backend running on http://localhost:${PORT}`);
    });
  });
}

export default app;
