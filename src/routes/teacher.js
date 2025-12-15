const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
require('dotenv').config();

const { initializeApp } = require("firebase/app");
const { getDatabase, ref, get, child } = require("firebase/database");

// Initialize Firebase
const firebaseConfig = {
    apiKey: process.env.FIREBASE_API_KEY,
    authDomain: process.env.FIREBASE_AUTH_DOMAIN,
    databaseURL: process.env.FIREBASE_DATABASE_URL,
    projectId: process.env.FIREBASE_PROJECT_ID,
    storageBucket: process.env.FIREBASE_STORAGE_BUCKET,
    messagingSenderId: process.env.FIREBASE_MESSAGING_SENDER_ID,
    appId: process.env.FIREBASE_APP_ID
};

const app = initializeApp(firebaseConfig);
const database = getDatabase(app);

// Initialize Supabase
const supabaseUrl = process.env.SUPABASE_URL;
const supabaseKey = process.env.SUPABASE_ANON_KEY;
const supabase = createClient(supabaseUrl, supabaseKey);

/**
 * Teacher Login API
 * Route: POST /login
 * (Mounted at /api/auth/teacher in index.js)
 */
router.post('/login', async (req, res) => {
    try {
        const { uni_reg_id, password } = req.body;

        if (!uni_reg_id || !password) {
            return res.status(400).json({
                success: false,
                message: "Missing Registration ID or Password"
            });
        }

        const { data: teacher, error } = await supabase
            .from('teachers_details')
            .select('*')
            .eq('uni_reg_id', uni_reg_id)
            .single();

        if (error || !teacher || teacher.password !== password) {
            return res.status(401).json({
                success: false,
                message: "Invalid credentials"
            });
        }

        const { password: _, ...safeTeacherData } = teacher;

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
// ====================================================================
// GET UNIT OVERALL COMPLETION (Aggregated Progress) - Teacher Route
// ====================================================================
router.post('/teacher/analytics/unit-completion', async (req, res) => {
    try {
        const { student_id, course_id, unit_id } = req.body;

        if (!student_id || !course_id || !unit_id) {
            return res.status(400).json({ error: "student_id, course_id, and unit_id are required" });
        }

        // 1. FETCH UNIT METADATA FROM FIREBASE (To find all Sub-Units)
        let subUnitsMap = {};
        try {
            const unitRef = ref(database, `EduCode/Courses/${course_id}/units/${unit_id}/sub-units`);
            const snap = await get(unitRef);
            if (snap.exists()) {
                subUnitsMap = snap.val();
            } else {
                return res.status(404).json({ success: false, message: "Unit not found in database" });
            }
        } catch (fbErr) {
            console.error("Firebase Error:", fbErr);
            return res.status(500).json({ error: "Failed to fetch unit structure" });
        }

        const subUnitIds = Object.keys(subUnitsMap);

        // 2. FETCH ALL RESULTS FOR THIS UNIT (Optimization: One Query)
        const { data: allResults } = await supabase
            .from('results')
            .select('sub_unit_id, result_type, submitted_at')
            .eq('student_id', student_id)
            .eq('unit_id', unit_id)
            .not('submitted_at', 'is', null);

        // 3. CALCULATE PROGRESS PER SUB-UNIT
        let totalProgressSum = 0;
        const breakdown = [];

        subUnitIds.forEach(subId => {
            const meta = subUnitsMap[subId];

            // A. Check Availability 
            const hasMCQ = meta.mcq !== undefined || (meta['total-mcq-questions'] && meta['total-mcq-questions'] > 0);
            const hasCoding = meta.coding !== undefined || (meta['total-coding-questions'] && meta['total-coding-questions'] > 0);

            // B. Check Submissions
            const mcqSubmitted = allResults.some(r => r.sub_unit_id === subId && r.result_type === 'mcq');
            const codingSubmitted = allResults.some(r => r.sub_unit_id === subId && r.result_type === 'coding');

            // C. Dynamic Weight Calculation
            let subUnitPercent = 0;

            if (hasMCQ && hasCoding) {
                // Scenario: Both exist (50% each)
                if (mcqSubmitted) subUnitPercent += 50;
                if (codingSubmitted) subUnitPercent += 50;
            }
            else if (hasMCQ && !hasCoding) {
                // Scenario: Only MCQ exists (100% weight)
                if (mcqSubmitted) subUnitPercent = 100;
            }
            else if (!hasMCQ && hasCoding) {
                // Scenario: Only Coding exists (100% weight)
                if (codingSubmitted) subUnitPercent = 100;
            }

            totalProgressSum += subUnitPercent;

            breakdown.push({
                sub_unit_id: subId,
                sub_unit_title: meta.title || meta.name || "Untitled Sub-Unit",
                progress_percentage: subUnitPercent,
                details: {
                    has_mcq: hasMCQ,
                    mcq_submitted: mcqSubmitted,
                    has_coding: hasCoding,
                    coding_submitted: codingSubmitted
                }
            });
        });

        // 4. CALCULATE OVERALL UNIT AVERAGE
        const overallCompletion = subUnitIds.length > 0
            ? Math.round(totalProgressSum / subUnitIds.length)
            : 0;

        return res.json({
            success: true,
            data: {
                unit_id: unit_id,
                total_sub_units: subUnitIds.length,
                overall_unit_completion: overallCompletion,
                sub_unit_breakdown: breakdown
            }
        });

    } catch (e) {
        console.error("Unit Completion Error:", e);
        res.status(500).json({ error: "SERVER_ERROR", details: e.message });
    }
});

module.exports = router;
