// server.js
import express from "express";
import cors from "cors";
import dotenv from "dotenv";
import { GoogleGenerativeAI } from "@google/generative-ai";
import mysql from "mysql2/promise";
import { v4 as uuidv4 } from 'uuid';


dotenv.config();

const app = express();
const PORT = process.env.PORT || 5000;

const allowedOrigins = [
  "https://mockverse-frontend.vercel.app",
  "http://localhost:5173"
];

app.use(cors({
  origin: function (origin, callback) {
    if (!origin || allowedOrigins.includes(origin)) {
      callback(null, true);
    } else {
      callback(new Error('Not allowed by CORS'));
    }
  },
  credentials: true
}));
app.use(express.json());

// Initialize Gemini
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);
const model = genAI.getGenerativeModel({ model: "gemini-2.0-flash" });

const db = await mysql.createConnection({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: process.env.DB_PORT,
});

db.connect((err) => {
  if (err) {
    console.error("❌ MySQL connection failed:", err);
    process.exit(1);
  }
  console.log("✅ Connected to Aiven MySQL");
});

//SIGNUP API
// SIGNUP API
app.post("/api/signup", async (req, res) => {
  const { name, email, password, phone_number } = req.body;
  const sql = `
    INSERT INTO users (name, email, password)
    VALUES (?, ?, ?)
  `;
  try {
    await db.query(sql, [name, email, password]);
    res.status(200).json({ message: "User registered successfully!" });
  } catch (err) {
    console.error("Error inserting user:", err);
    res.status(500).json({ error: "Internal server error" });
  }
});

// LOGIN API
app.post("/api/login", async (req, res) => {
  const { email, password } = req.body;

  console.log("🟡 Login Attempt:");
  console.log("➡ Email:", email);
  console.log("➡ Password:", password);

  if (!email || !password) {
    console.warn("⚠ Missing email or password");
    return res.status(400).json({ error: "Email and password are required." });
  }

  const sql = `SELECT id, name, email, password FROM users WHERE email = ?`;

  try {
    const [results] = await db.query(sql, [email]);
    if (results.length === 0) {
      console.warn("❌ No user found with this email");
      return res.status(401).json({ error: "Invalid email" });
    }

    const user = results[0];
    console.log("✅ User Found:", user.email);
    console.log("🔑 DB Password:", user.password);
    console.log("🔑 Entered Password:", password);

    if (user.password === password) {
      console.log("✅ Password matched. Login successful!");
      const userData = {
        id: user.id,
        name: user.name,
        email: user.email,
      };
      return res.status(200).json({
        success: true,
        message: "Login successful!",
        user: userData,
      });
    } else {
      console.warn("❌ Password mismatch");
      return res.status(401).json({ error: "Invalid password" });
    }
  } catch (err) {
    console.error("❌ Error during login:", err);
    return res.status(500).json({ error: "Internal server error" });
  }
});

/**
 * Route: POST /start-interview
 * Description: Generate 10 interview questions based on topic and difficulty
 */
app.post("/start-interview", async (req, res) => {
  const { topic, difficulty } = req.body;

  if (!topic || !difficulty) {
    console.log("❌ Missing topic or difficulty");
    return res.status(400).json({ error: "Topic and difficulty required" });
  }

  try {
    const prompt = `
    Generate 10 mock interview questions for the topic: "${topic}".
    Difficulty level: "${difficulty}" (easy, medium, hard).
    Format the response as a numbered list (1 to 10), only questions, no answers.
    `;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();
    console.log("✅ Generated Questions:\n", text);

    // Split questions into array
    const questions = text
      .split(/\n+/)
      .filter((line) => /^\d+\./.test(line))
      .map((q) => q.replace(/^\d+\.\s*/, "").trim());

    console.log("🟢 Parsed Questions Array:", questions);
    res.json({ questions });
  } catch (err) {
    console.error("❌ Failed to generate questions:", err.message);
    res.status(500).json({ error: "Failed to generate questions" });
  }
});

/**
 * Route: POST /check-answer
 * Description: Use Gemini to evaluate the user's answer
 */
app.post("/check-answer", async (req, res) => {
  const { question, answer } = req.body;

  console.log("🔍 Evaluating Answer:\n", { question, answer });

  if (!question || !answer) {
    console.log("❌ Missing question or answer");
    return res.status(400).json({ error: "Question and answer required" });
  }

  try {
   const prompt = `
Question: ${question}
Answer: ${answer}

Evaluate the answer strictly based on the question. 
- Is the answer correct? (Yes/No)
- If incorrect or incomplete, explain what is missing or needs improvement in 1-2 lines.
- If correct, mention it briefly in 1 line.

Respond in a clear and concise manner.
`;


    const result = await model.generateContent(prompt);
    const response = await result.response;
    const feedback = response.text();
    let is_correct = 0;
const match = feedback.match(/Is the answer correct\?\s*\(?([Yy]es|[Nn]o)\)?/);
if (match) {
  is_correct = match[1].toLowerCase() === "yes" ? 1 : 0;
} else if (/correct:\s*yes/i.test(feedback)) {
  is_correct = 1;
} else if (/correct:\s*no/i.test(feedback)) {
  is_correct = 0;
} else if (/^-+\s*yes\b/i.test(feedback)) { // <-- add this line
  is_correct = 1;
} else if (/^-+\s*no\b/i.test(feedback)) { // <-- add this line
  is_correct = 0;
}

    console.log("🟡 Answer Evaluation:\n", feedback, is_correct);
    res.json({ feedback , is_correct});
  } catch (err) {
    console.error("❌ Error evaluating answer:", err.message);
    res.status(500).json({ error: "Failed to evaluate answer" });
  }
});

app.post('/interview/start', async (req, res) => {
    console.log("Request Body:", req.body);
  const sessionId = uuidv4();
  const userId = req.body.user_id || 1; // Replace or get from auth
   if (!userId) {
    return res.status(400).json({ error: "Missing user_id in request body" });
  }

  try {
    await db.query(
      'INSERT INTO interview_sessions (session_id, user_id, started_at) VALUES (?, ?, NOW())',
      [sessionId, userId]
    );

    res.json({ sessionId });
  } catch (error) {
    console.error("Error saving session:", error);
    res.status(500).json({ error: "Failed to create session" });
  }
});



app.post('/interview/save-answer', async (req, res) => {
  const { session_id, user_id, question, user_answer, is_correct } = req.body;
  if (!session_id || !user_id || !question || !user_answer || typeof is_correct === "undefined") {
    return res.status(400).json({ error: "Missing required fields" });
  }
  try {
    await db.query(
      `INSERT INTO interview_attempts (session_id, user_id, question, user_answer, is_correct, created_at)
       VALUES (?, ?, ?, ?, ?, NOW())`,
      [session_id, user_id, question, user_answer, is_correct]
    );
    res.status(200).json({ message: "Attempt saved" });
  } catch (err) {
    console.error("Error saving attempt:", err);
    res.status(500).json({ error: "Database error" });
  }
});

app.post('/save-interview-response', async (req, res) => {
  const { question, answer, feedback, sessionId, userId } = req.body;

  try {
    await db.query(
      'INSERT INTO interview_responses (user_id, session_id, question, answer, feedback) VALUES (?, ?, ?, ?, ?)',
      [userId, sessionId, question, answer, feedback]
    );

    res.status(200).json({ message: "Saved successfully" });
  } catch (error) {
    console.error("DB Insert Error:", error);
    res.status(500).json({ error: "Failed to save response" });
  }
});

app.get('/interview/score/:sessionId', async (req, res) => {
  const { sessionId } = req.params;
  try {
    const [rows] = await db.query(
      `SELECT 
         SUM(is_correct) AS correct, 
         COUNT(*) AS total 
       FROM interview_attempts 
       WHERE session_id = ?`,
      [sessionId]
    );
    res.json({
      correct: rows[0].correct || 0,
      total: rows[0].total || 0
    });
  } catch (err) {
    console.error("Error fetching score:", err);
    res.status(500).json({ error: "Failed to fetch score" });
  }
});




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
      throw new Error(
        "JUDGE0_API_KEY is not set. Add it to backend/.env (see setup instructions)."
      );
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

// Judge0 status ids: 1/2 = queued/processing (shouldn't see these with wait=true),
// 3 = Accepted, 6 = Compilation Error. Everything else (4/5/7-14) is some
// flavor of runtime failure (wrong answer isn't a Judge0 concept here since
// we're not passing expected_output — we diff stdout ourselves).
const JUDGE0_ACCEPTED = 3;
const JUDGE0_COMPILE_ERROR = 6;

function decodeBase64(value) {
  return value ? Buffer.from(value, "base64").toString("utf-8") : "";
}

async function runOnJudge0(languageKey, source, stdin) {
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
    throw new Error(
      "Judge0 free-tier daily limit reached. Try again tomorrow, or upgrade your RapidAPI plan."
    );
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
}

app.post("/execute", async (req, res) => {
  const { language, source, stdin } = req.body;

  if (!language || !source) {
    return res.status(400).json({ error: "language and source are required" });
  }

  try {
    const result = await runOnJudge0(language, source, stdin);
    res.json(result);
  } catch (err) {
    console.error("❌ Judge0 execution failed:", err.message);
    res.status(500).json({ error: "Code execution failed", details: err.message });
  }
});

app.post("/run-tests", async (req, res) => {
  const { language, source, testCases } = req.body;

  if (!language || !source || !Array.isArray(testCases)) {
    return res.status(400).json({ error: "language, source, and testCases[] are required" });
  }

  try {
    const results = [];
    for (const testCase of testCases) {
      const { stdout, stderr, compileStderr } = await runOnJudge0(language, source, testCase.input);

      if (compileStderr) {
        return res.json({
          compileError: compileStderr,
          results,
        });
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
    console.error("❌ Test run failed:", err.message);
    res.status(500).json({ error: "Test run failed", details: err.message });
  }
});

app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
