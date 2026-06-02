import express from "express";

import {
  startInterview,
  checkAnswer,
  createSession,
  saveAnswer,
  saveInterviewResponse,
  getScore,
} from "../controllers/interviewController.js";

const router = express.Router();

router.post("/start-interview", startInterview);

router.post("/check-answer", checkAnswer);

router.post("/interview/start", createSession);

router.post("/interview/save-answer", saveAnswer);

router.post(
  "/save-interview-response",
  saveInterviewResponse
);

router.get(
  "/interview/score/:sessionId",
  getScore
);

export default router;