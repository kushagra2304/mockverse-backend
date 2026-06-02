import model from "../config/gemini.js";
import db from "../config/db.js";
import { v4 as uuidv4 } from "uuid";
import parseFeedback from "../utils/parseFeedback.js";

export const startInterview = async (req, res) => {
  const { topic, difficulty } = req.body;

  if (!topic || !difficulty) {
    return res.status(400).json({
      error: "Topic and difficulty required",
    });
  }

  try {
    const prompt = `
Generate 10 mock interview questions for topic "${topic}".
Difficulty: "${difficulty}".

Format:
1. Question
2. Question

Only questions.
`;

    const result = await model.generateContent(prompt);
    const response = await result.response;
    const text = response.text();

    const questions = text
      .split(/\n+/)
      .filter((line) => /^\d+\./.test(line))
      .map((q) => q.replace(/^\d+\.\s*/, "").trim());

    res.json({ questions });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to generate questions",
    });
  }
};

export const checkAnswer = async (req, res) => {
  const { question, answer } = req.body;

  if (!question || !answer) {
    return res.status(400).json({
      error: "Question and answer required",
    });
  }

  try {
    const prompt = `
Question: ${question}

Answer: ${answer}

Evaluate:
- Is answer correct? (Yes/No)
- If wrong, explain briefly
- If correct, mention briefly
`;

    const result = await model.generateContent(prompt);

    const response = await result.response;

    const feedback = response.text();

    const is_correct = parseFeedback(feedback);

    res.json({
      feedback,
      is_correct,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to evaluate answer",
    });
  }
};

export const createSession = async (req, res) => {
  const sessionId = uuidv4();

  const userId = req.body.user_id;

  if (!userId) {
    return res.status(400).json({
      error: "Missing user_id",
    });
  }

  try {
    await db.query(
      `INSERT INTO interview_sessions
       (session_id, user_id, started_at)
       VALUES (?, ?, NOW())`,
      [sessionId, userId]
    );

    res.json({ sessionId });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to create session",
    });
  }
};

export const saveAnswer = async (req, res) => {
  const {
    session_id,
    user_id,
    question,
    user_answer,
    is_correct,
  } = req.body;

  try {
    await db.query(
      `INSERT INTO interview_attempts
      (session_id, user_id, question, user_answer, is_correct, created_at)
      VALUES (?, ?, ?, ?, ?, NOW())`,
      [
        session_id,
        user_id,
        question,
        user_answer,
        is_correct,
      ]
    );

    res.status(200).json({
      message: "Attempt saved",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Database error",
    });
  }
};

export const saveInterviewResponse = async (req, res) => {
  const {
    question,
    answer,
    feedback,
    sessionId,
    userId,
  } = req.body;

  try {
    await db.query(
      `INSERT INTO interview_responses
      (user_id, session_id, question, answer, feedback)
      VALUES (?, ?, ?, ?, ?)`,
      [
        userId,
        sessionId,
        question,
        answer,
        feedback,
      ]
    );

    res.status(200).json({
      message: "Saved successfully",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to save response",
    });
  }
};

export const getScore = async (req, res) => {
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
      total: rows[0].total || 0,
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Failed to fetch score",
    });
  }
};