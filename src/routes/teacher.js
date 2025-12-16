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


// ====================================================================
// GET SECTION OVERALL COMPLETION (Practice Only) - Teacher Route
// ====================================================================
router.post('/teacher/analytics/section-completion', async (req, res) => {
    try {
        const { section_name, course_id, university_id } = req.body;

        if (!section_name || !course_id || !university_id) {
            return res.status(400).json({ error: "section_name, course_id, and university_id are required" });
        }

        // ---------------------------------------------------------
        // 1. FETCH STUDENTS IN SECTION
        // ---------------------------------------------------------
        const { data: students, error: studentError } = await supabase
            .from('students')
            .select('student_id, student_name')
            .eq('section', section_name)
            .eq('uni_id', university_id); // Ensure we only get this uni's students

        if (studentError) throw studentError;

        if (!students || students.length === 0) {
            return res.json({
                success: true,
                data: {
                    section_name,
                    total_students: 0,
                    section_overall_completion: 0
                }
            });
        }

        const studentIds = students.map(s => s.student_id);

        // ---------------------------------------------------------
        // 2. BUILD "PRACTICE BLUEPRINT" FROM FIREBASE
        // ---------------------------------------------------------
        let practiceBlueprint = []; // List of valid sub-units to check

        try {
            const courseRef = ref(database, `EduCode/Courses/${course_id}/units`);
            const snap = await get(courseRef);

            if (snap.exists()) {
                const unitsData = snap.val();

                // Traverse Units
                Object.keys(unitsData).forEach(unitKey => {
                    const subUnits = unitsData[unitKey]['sub-units'] || {};

                    // Traverse Sub-Units
                    Object.keys(subUnits).forEach(subKey => {
                        const subMeta = subUnits[subKey];

                        // STRICT FILTER: Only include if sub_type is "practice"
                        if (subMeta['sub_type'] === 'practice') {

                            // Determine requirements for 100%
                            const hasMCQ = subMeta.mcq !== undefined || (subMeta['total-mcq-questions'] && subMeta['total-mcq-questions'] > 0);
                            const hasCoding = subMeta.coding !== undefined || (subMeta['total-coding-questions'] && subMeta['total-coding-questions'] > 0);

                            // Only add if there is actual content to do
                            if (hasMCQ || hasCoding) {
                                practiceBlueprint.push({
                                    sub_unit_id: subKey,
                                    has_mcq: hasMCQ,
                                    has_coding: hasCoding
                                });
                            }
                        }
                    });
                });
            }
        } catch (fbErr) {
            console.error("Firebase Blueprint Error:", fbErr);
            return res.status(500).json({ error: "Failed to fetch course structure" });
        }

        const totalPracticeItems = practiceBlueprint.length;

        if (totalPracticeItems === 0) {
            return res.json({ success: true, data: { section_name, message: "No practice content found in this course.", section_overall_completion: 0 } });
        }

        // ---------------------------------------------------------
        // 3. BULK FETCH SUBMISSIONS (Postgres)
        // ---------------------------------------------------------
        // We fetch ALL valid submissions for these students in this course
        const { data: allResults } = await supabase
            .from('results')
            .select('student_id, sub_unit_id, result_type, submitted_at')
            .in('student_id', studentIds)
            .eq('course_id', course_id)
            .not('submitted_at', 'is', null);

        // Optimize Lookup: Create a Set of "Student_SubUnit_Type"
        // Example: "student123_subUnitABC_mcq"
        const submissionSet = new Set();
        (allResults || []).forEach(r => {
            submissionSet.add(`${r.student_id}_${r.sub_unit_id}_${r.result_type}`);
        });

        // ---------------------------------------------------------
        // 4. CALCULATE PROGRESS (In-Memory Loop)
        // ---------------------------------------------------------
        let sectionTotalPercent = 0;
        const studentPerformance = [];

        students.forEach(student => {
            let studentSubUnitSum = 0;

            // Check against Blueprint
            practiceBlueprint.forEach(item => {
                let itemProgress = 0;
                const mcqKey = `${student.student_id}_${item.sub_unit_id}_mcq`;
                const codingKey = `${student.student_id}_${item.sub_unit_id}_coding`;

                const didMCQ = submissionSet.has(mcqKey);
                const didCoding = submissionSet.has(codingKey);

                if (item.has_mcq && item.has_coding) {
                    if (didMCQ) itemProgress += 50;
                    if (didCoding) itemProgress += 50;
                }
                else if (item.has_mcq) {
                    if (didMCQ) itemProgress = 100;
                }
                else if (item.has_coding) {
                    if (didCoding) itemProgress = 100;
                }

                studentSubUnitSum += itemProgress;
            });

            // Student Average for Course
            const studentAvg = Math.round(studentSubUnitSum / totalPracticeItems);

            sectionTotalPercent += studentAvg;

            studentPerformance.push({
                student_name: student.student_name,
                progress: studentAvg
            });
        });

        // ---------------------------------------------------------
        // 5. FINAL AGGREGATION
        // ---------------------------------------------------------
        const sectionAverage = Math.round(sectionTotalPercent / students.length);

        return res.json({
            success: true,
            data: {
                section_name: section_name,
                course_id: course_id,
                total_students: students.length,
                total_practice_sub_units: totalPracticeItems,
                section_overall_completion: sectionAverage,
                student_performance: studentPerformance // Optional: Remove if list is too long
            }
        });

    } catch (e) {
        console.error("Section Analytics Error:", e);
        res.status(500).json({ error: "SERVER_ERROR", details: e.message });
    }
});



// GET SECTION EXAM PROGRESS (Derives Batch from Course)
// ====================================================================
router.post('/teacher/analytics/section-exam-progress', async (req, res) => {
    try {
        // INPUT: Only course_id and section_name required
        const { course_id, section_name } = req.body;

        if (!course_id || !section_name) {
            return res.status(400).json({ error: "course_id and section_name are required" });
        }

        // ---------------------------------------------------------
        // 1. GET BATCH_ID FROM COURSE (The Fix)
        // ---------------------------------------------------------
        const { data: courseData, error: courseError } = await supabase
            .from('courses')
            .select('batch_id')
            .eq('course_id', course_id)
            .single();

        if (courseError || !courseData) {
            return res.status(404).json({ error: "Course not found or not linked to a batch." });
        }

        const batchId = courseData.batch_id;

        // ---------------------------------------------------------
        // 2. FETCH STUDENTS IN SECTION & BATCH
        // ---------------------------------------------------------
        // We filter by 'batch_id' + 'section' to ensure we get the right students
        const { data: students, error: studentError } = await supabase
            .from('students')
            .select('student_id, student_name, uni_reg_id')
            .eq('section', section_name)
            .eq('batch_id', batchId);

        if (studentError) throw studentError;

        if (!students || students.length === 0) {
            return res.json({
                success: true,
                data: {
                    section_name,
                    message: "No students found in this section for this batch.",
                    students: []
                }
            });
        }

        const studentIds = students.map(s => s.student_id);

        // ---------------------------------------------------------
        // 3. BUILD "EXAM BLUEPRINT" FROM FIREBASE
        // ---------------------------------------------------------
        let examBlueprint = [];

        try {
            const courseRef = ref(database, `EduCode/Courses/${course_id}/units`);
            const snap = await get(courseRef);

            if (snap.exists()) {
                const unitsData = snap.val();

                Object.keys(unitsData).forEach(unitKey => {
                    const subUnits = unitsData[unitKey]['sub-units'] || {};

                    Object.keys(subUnits).forEach(subKey => {
                        const subMeta = subUnits[subKey];

                        // STRICT FILTER: Check if sub_type is 'exam'
                        if (subMeta['sub_type'] === 'exam') {

                            // Check availability of questions
                            const hasMCQ = subMeta.mcq !== undefined || (subMeta['total-mcq-questions'] && subMeta['total-mcq-questions'] > 0);
                            const hasCoding = subMeta.coding !== undefined || (subMeta['total-coding-questions'] && subMeta['total-coding-questions'] > 0);

                            if (hasMCQ || hasCoding) {
                                examBlueprint.push({
                                    sub_unit_id: subKey,
                                    has_mcq: hasMCQ,
                                    has_coding: hasCoding
                                });
                            }
                        }
                    });
                });
            }
        } catch (fbErr) {
            console.error("Firebase Blueprint Error:", fbErr);
            return res.status(500).json({ error: "Failed to fetch course structure" });
        }

        const totalExamItems = examBlueprint.length;

        if (totalExamItems === 0) {
            return res.json({ success: true, data: { section_name, message: "No exams found in this course.", students: [] } });
        }

        // ---------------------------------------------------------
        // 4. BULK FETCH EXAM RESULTS
        // ---------------------------------------------------------
        const { data: allResults } = await supabase
            .from('results')
            .select('student_id, sub_unit_id, result_type, submitted_at, start_config, end_config')
            .in('student_id', studentIds)
            .eq('course_id', course_id)
            .not('submitted_at', 'is', null);

        // Map for fast lookup
        const resultMap = new Map();
        (allResults || []).forEach(r => {
            resultMap.set(`${r.student_id}_${r.sub_unit_id}_${r.result_type}`, r);
        });

        // ---------------------------------------------------------
        // 5. CALCULATE PROGRESS & EXTRACT CONFIGS
        // ---------------------------------------------------------
        const studentProgressList = students.map(student => {
            let totalProgressSum = 0;
            let lastStartConfig = null;
            let lastEndConfig = null;

            examBlueprint.forEach(examItem => {
                let itemProgress = 0;

                const mcqKey = `${student.student_id}_${examItem.sub_unit_id}_mcq`;
                const codingKey = `${student.student_id}_${examItem.sub_unit_id}_coding`;

                const mcqResult = resultMap.get(mcqKey);
                const codingResult = resultMap.get(codingKey);

                const didMCQ = !!mcqResult;
                const didCoding = !!codingResult;

                // Extract Configs (Prefer Coding config if available, else MCQ)
                if (didCoding) {
                    if (codingResult.start_config) lastStartConfig = codingResult.start_config;
                    if (codingResult.end_config) lastEndConfig = codingResult.end_config;
                } else if (didMCQ) {
                    if (mcqResult.start_config) lastStartConfig = mcqResult.start_config;
                    if (mcqResult.end_config) lastEndConfig = mcqResult.end_config;
                }

                // 50/50 Progress Logic
                if (examItem.has_mcq && examItem.has_coding) {
                    if (didMCQ) itemProgress += 50;
                    if (didCoding) itemProgress += 50;
                }
                else if (examItem.has_mcq) {
                    if (didMCQ) itemProgress = 100;
                }
                else if (examItem.has_coding) {
                    if (didCoding) itemProgress = 100;
                }

                totalProgressSum += itemProgress;
            });

            // Calculate Overall Average
            const examAvg = Math.round(totalProgressSum / totalExamItems);

            return {
                student_name: student.student_name,
                uni_reg_id: student.uni_reg_id, // Included in response, not needed in input
                exam_completion_percentage: examAvg,
                debug_configs: {
                    start_config: lastStartConfig || {},
                    end_config: lastEndConfig || {}
                }
            };
        });

        return res.json({
            success: true,
            data: {
                section_name,
                total_students: students.length,
                total_exams_in_course: totalExamItems,
                students: studentProgressList
            }
        });

    } catch (e) {
        console.error("Exam Analytics Error:", e);
        res.status(500).json({ error: "SERVER_ERROR", details: e.message });
    }
});

module.exports = router;
