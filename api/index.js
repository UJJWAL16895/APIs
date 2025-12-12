const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Initialize Supabase
// Ensure these are in your .env file
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Teacher Login API
 * Route: POST /api/auth/teacher/login
 * Body: { "uni_reg_id": "K23RN...", "password": "..." }
 */
app.post('/api/auth/teacher/login', async (req, res) => {
  try {
    // 1. Destructure inputs
    const { uni_reg_id, password } = req.body;

    // Validation: Ensure both fields are provided
    if (!uni_reg_id || !password) {
      return res.status(400).json({
        success: false,
        message: "Missing Registration ID or Password"
      });
    }

    // 2. Database Query: Fetch the user specifically by uni_reg_id
    const { data: teacher, error } = await supabase
      .from('teachers_details')
      .select('*')
      .eq('uni_reg_id', uni_reg_id)
      .single();

    // 3. Security Check: Validate User Existence AND Password
    if (error || !teacher || teacher.password !== password) {
      return res.status(401).json({
        success: false,
        message: "Invalid credentials"
      });
    }

    // 4. Data Sanitization: Remove the password from the response
    const { password: _, ...safeTeacherData } = teacher;

    // 5. Success Response
    return res.status(200).json({
      success: true,
      data: safeTeacherData
    });

  } catch (err) {
    console.error("Login Error:", err);
    return res.status(500).json({
      success: false,
      message: "Internal Server Error"
    });
  }
});

// Root endpoint for testing
app.get('/', (req, res) => {
  res.json({ message: "Teacher Login API is running" });
});

// Start the server if running locally
if (require.main === module) {
  const PORT = process.env.PORT || 3000;
  app.listen(PORT, () => console.log(`Server running on port ${PORT}`));
}

module.exports = app;
