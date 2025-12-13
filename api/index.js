const express = require('express');
const { createClient } = require('@supabase/supabase-js');
const cors = require('cors');
require('dotenv').config();

const app = express();

// Middleware
app.use(cors());
app.use(express.json());

// Import Routes
const teacherRouter = require('../src/routes/teacher');
const studentDashboardRouter = require('../src/routes/student_dashboard');
const universityRouter = require('../src/routes/university_admin');

// Mount Routes
// All teacher auth routes will be prefixed with /api/auth/teacher
app.use('/api/auth/teacher', teacherRouter);
// Student Dashboard routes mounted at /api
app.use('/api', studentDashboardRouter);
// University routes mounted at /api/university
app.use('/api/university', universityRouter);

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
