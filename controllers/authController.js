import db from "../config/db.js";

export const signup = async (req, res) => {
  const { name, email, password } = req.body;

  try {
    await db.query(
      `INSERT INTO users (name, email, password)
       VALUES (?, ?, ?)`,
      [name, email, password]
    );

    res.status(200).json({
      message: "User registered successfully!",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Internal server error",
    });
  }
};

export const login = async (req, res) => {
  const { email, password } = req.body;

  try {
    const [results] = await db.query(
      `SELECT id, name, email, password
       FROM users
       WHERE email = ?`,
      [email]
    );

    if (results.length === 0) {
      return res.status(401).json({
        error: "Invalid email",
      });
    }

    const user = results[0];

    if (user.password === password) {
      return res.status(200).json({
        success: true,
        message: "Login successful!",
        user: {
          id: user.id,
          name: user.name,
          email: user.email,
        },
      });
    }

    return res.status(401).json({
      error: "Invalid password",
    });
  } catch (err) {
    console.error(err);

    res.status(500).json({
      error: "Internal server error",
    });
  }
};