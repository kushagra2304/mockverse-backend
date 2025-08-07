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
  'http://localhost:5173',
  'https://mockverse-frontend.vercel.app/' 
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
app.post("/api/signup", (req, res) => {
  const { name, email, password, phone_number } = req.body;

  const sql = `
    INSERT INTO users (name, email, password)
    VALUES (?, ?, ?)
  `;

  db.query(sql, [name, email, password], (err, result) => {
    if (err) {
      console.error("Error inserting user:", err);
      return res.status(500).json({ error: "Internal server error" });
    }
    res.status(200).json({ message: "User registered successfully!" });
  });
});

// LOGIN API
app.post("/api/login", (req, res) => {
  const { email, password } = req.body;

  console.log("🟡 Login Attempt:");
  console.log("➡ Email:", email);
  console.log("➡ Password:", password);

  if (!email || !password) {
    console.warn("⚠ Missing email or password");
    return res.status(400).json({ error: "Email and password are required." });
  }

  const sql = `SELECT id, name, email, password FROM users WHERE email = ?`;

  db.query(sql, [email], (err, results) => {
    if (err) {
      console.error("❌ Error during login:", err);
      return res.status(500).json({ error: "Internal server error" });
    }

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
      
      // Don't send password in the response
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
  });
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




app.listen(PORT, () => {
  console.log(`🚀 Server running on http://localhost:${PORT}`);
});
