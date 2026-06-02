import express from "express";
import dotenv from "dotenv";

import corsMiddleware from "./middleware/corsMiddleware.js";

import authRoutes from "./routes/authRoutes.js";
import interviewRoutes from "./routes/interviewRoutes.js";

dotenv.config();

const app = express();

const PORT = process.env.PORT || 5000;

app.use(corsMiddleware);

app.use(express.json());

// Routes
app.use("/api", authRoutes);

app.use("/interview", interviewRoutes);

app.listen(PORT, () => {
  console.log(`Server running on port ${PORT}`);
});