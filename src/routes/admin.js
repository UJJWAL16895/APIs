const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

/**
 * Super Admin Login
 * Route: POST /login
 * Body: { "username": "admin", "password": "..." }
 */
router.post('/login', async (req, res) => {
    try {
        const { username, password } = req.body;

        // Check against super_admins table
        const { data: admin, error } = await supabase
            .from('super_admins')
            .select('*')
            .eq('username', username)
            .single();

        if (error || !admin || admin.password !== password) {
            return res.status(401).json({
                success: false,
                message: "Invalid Admin Credentials"
            });
        }

        // Return admin info (exclude password)
        const { password: _, ...safeAdmin } = admin;
        return res.status(200).json({
            success: true,
            data: safeAdmin
        });

    } catch (err) {
        console.error("Admin Login Error:", err);
        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
});

/**
 * List All Teachers
 * Route: GET /teachers
 */
router.get('/teachers', async (req, res) => {
    try {
        const { data: teachers, error } = await supabase
            .from('teachers_details')
            .select('id, student_name, uni_reg_id, email, phone_number, department') // fetching student_name as teacher name? Assuming schema.
            .order('student_name', { ascending: true }); // Adjust column name if 'name' or 'full_name' exists

        if (error) throw error;

        return res.json({
            success: true,
            data: teachers
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            message: err.message
        });
    }
});

/**
 * Ghost Login (Simulate Teacher)
 * Route: POST /ghost-login
 * Body: { "uni_reg_id": "..." }
 */
router.post('/ghost-login', async (req, res) => {
    try {
        const { uni_reg_id } = req.body;

        if (!uni_reg_id) {
            return res.status(400).json({ success: false, message: "Missing Registration ID" });
        }

        // Fetch teacher details WITHOUT checking password
        const { data: teacher, error } = await supabase
            .from('teachers_details')
            .select('*')
            .eq('uni_reg_id', uni_reg_id)
            .single();

        if (error || !teacher) {
            return res.status(404).json({
                success: false,
                message: "Teacher not found"
            });
        }

        // Sanitize
        const { password: _, ...safeTeacherData } = teacher;

        return res.status(200).json({
            success: true,
            data: safeTeacherData,
            message: "Ghost login successful"
        });

    } catch (err) {
        return res.status(500).json({
            success: false,
            message: "Internal Server Error"
        });
    }
});

module.exports = router;
