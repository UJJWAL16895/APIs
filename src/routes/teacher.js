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
// 1. GET SUB-UNIT DETAILS (Deep Dive + MCQ/Coding Stats)
// ====================================================================
router.post('/teacher/analytics/sub-unit-details', async (req, res) => {
    try {
        const { student_id, course_id, unit_id, sub_unit_id, result_type = 'coding', attempt } = req.body;

        if (!student_id) return res.status(400).json({ error: "student_id is required" });
        if (attempt === undefined || attempt === null) return res.status(400).json({ error: "Attempt number is required" });

        const attemptNum = Number(attempt);

        // 1. Fetch Result Row (Postgres)
        const { data: resultRow } = await supabase
            .from('results')
            .select('*')
            .eq('student_id', student_id)
            .eq('course_id', course_id)
            .eq('unit_id', unit_id)
            .eq('sub_unit_id', sub_unit_id)
            .eq('attempt_count', attemptNum)
            .eq('result_type', result_type)
            .limit(1)
            .maybeSingle();

        // 2. Fetch Raw Submissions (Postgres)
        const { data: dbSubmissions } = await supabase
            .from('student_submission')
            .select('*')
            .eq('student_id', student_id)
            .eq('course_id', course_id)
            .eq('unit_id', unit_id)
            .eq('sub_unit_id', sub_unit_id)
            .eq('attempt', attemptNum);

        if (!resultRow && (!dbSubmissions || dbSubmissions.length === 0)) {
            return res.status(404).json({ success: false, message: "No data found for this attempt" });
        }

        // 3. FETCH FIREBASE METADATA (For "Questions to Show" Limit)
        let subUnitMeta = {};
        let validQuestionIds = [];
        let totalAvailable = 0;
        let totalToShow = 0;

        try {
            const subUnitRef = ref(database, `EduCode/Courses/${course_id}/units/${unit_id}/sub-units/${sub_unit_id}`);
            const snap = await get(subUnitRef);
            if (snap.exists()) {
                subUnitMeta = snap.val();
                if (result_type === 'mcq') {
                    const mcqObj = subUnitMeta.mcq || {};
                    validQuestionIds = Object.keys(mcqObj);
                    totalAvailable = validQuestionIds.length;
                    totalToShow = Number(subUnitMeta['mcq-question-to-show']) || totalAvailable;
                } else {
                    const codingObj = subUnitMeta.coding || {};
                    validQuestionIds = Object.keys(codingObj);
                    totalAvailable = validQuestionIds.length;
                    totalToShow = Number(subUnitMeta['questions-to-show']) || totalAvailable;
                }
            }
        } catch (fbErr) {
            console.error("Firebase Meta Fetch Error:", fbErr);
        }

        // 4. FILTER SUBMISSIONS (Strict Type Check)
        const filteredSubmissions = (dbSubmissions || []).filter(sub =>
            validQuestionIds.includes(sub.question_id)
        );

        // 5. CALCULATE COMPLETION STATS
        const userSubmittedCount = filteredSubmissions.length;
        let completionPct = totalToShow > 0 ? Math.round((userSubmittedCount / totalToShow) * 100) : 0;
        if (completionPct > 100) completionPct = 100;

        const completionStats = {};
        if (result_type === 'mcq') {
            completionStats.total_mcq = totalAvailable;
            completionStats.total_mcq_show = totalToShow;
            completionStats.user_submitted_count = userSubmittedCount;
            completionStats.question_completion_percentage = completionPct;
        } else {
            completionStats.total_coding = totalAvailable;
            completionStats.total_coding_show = totalToShow;
            completionStats.user_submitted_count = userSubmittedCount;
            completionStats.question_completion_percentage = completionPct;
        }

        // 6. ENRICH SUBMISSIONS (Real Data from Firebase)
        let enrichedSubmissions = [];
        if (filteredSubmissions.length > 0) {
            enrichedSubmissions = await Promise.all(filteredSubmissions.map(async (sub) => {
                const questionId = sub.question_id;
                let firebaseData = {};
                try {
                    const qRef = ref(database, `EduCode/Courses/${course_id}/units/${unit_id}/sub-units/${sub_unit_id}/${result_type}/${questionId}`);
                    const qSnapshot = await get(qRef);
                    if (qSnapshot.exists()) firebaseData = qSnapshot.val();
                } catch (err) { }

                const isSubmitted = sub.status !== 'pending' && sub.status !== 'not_started';

                if (result_type === 'coding') {
                    const sampleTC = firebaseData['sample-input-output'] || [];
                    const hiddenTC = firebaseData['hidden-test-cases'] || [];
                    const totalMarks = hiddenTC.length * 10;

                    // Fetch Correct Code
                    let rightCode = "// Solution not available";
                    if (firebaseData['compiler-code']) {
                        rightCode = typeof firebaseData['compiler-code'] === 'object'
                            ? firebaseData['compiler-code'].code
                            : firebaseData['compiler-code'];
                    }

                    const allTestCases = [
                        ...sampleTC.map((tc, i) => ({
                            name: `Sample Case ${i + 1}`,
                            input: tc.input || "",
                            expected_output: tc.output || ""
                        })),
                        ...hiddenTC.map((tc, i) => ({
                            name: `Hidden Case ${i + 1}`,
                            input: tc.input || "[Hidden]",
                            expected_output: tc.output || "[Hidden]"
                        }))
                    ];

                    return {
                        type: "coding",
                        question_id: questionId,
                        question_title: firebaseData['question-description'] ? "Coding Problem" : `Question ${questionId}`,
                        question_desc: firebaseData['question-description'] || "Description unavailable",
                        submitted_answer: sub.last_submitted_code || "// No code",
                        correct_code: rightCode,
                        status: sub.status,
                        is_submitted: isSubmitted,
                        score_obtained: sub.score,
                        total_question_marks: totalMarks,
                        test_cases: allTestCases
                    };
                } else {
                    // MCQ
                    const options = firebaseData['options'] || [];
                    const userChoiceIndex = parseInt(sub.last_submitted_code || "-1");
                    const userSelectedOption = options[userChoiceIndex] || { option: "Unknown / No Selection" };

                    return {
                        type: "mcq",
                        question_id: questionId,
                        question_title: firebaseData['question'] || "MCQ Question",
                        options: options,
                        submitted_answer_index: userChoiceIndex,
                        submitted_answer_text: userSelectedOption.option,
                        is_submitted: isSubmitted,
                        is_correct: userSelectedOption.isAnswer || false,
                        score_obtained: sub.score
                    };
                }
            }));
        }

        // 7. General Metrics
        const analytics = resultRow?.analytics || {};
        const score = Number(resultRow?.marks_obtained) || 0;
        const total = Number(resultRow?.total_marks) || 100;
        const percent = Math.round((score / total) * 100);
        const isPass = percent >= 40;

        const proctoring = {
            face_warnings: analytics.faceWarnings || 0,
            focus_lost_count: analytics.lostFocusCount || 0,
            network_disconnects: analytics.internetDisconnects || 0,
            blocked_seconds: analytics.blockedSeconds || 0,
            tab_switches: analytics.tabSwitches || 0
        };

        return res.json({
            success: true,
            mode: "deep_dive",
            data: {
                overview: {
                    attempt_number: attemptNum,
                    status: isPass ? "Passed" : "Failed",
                    total_score: score,
                    max_score: total,
                    percentage: percent
                },
                completion_stats: completionStats,
                proctoring_metrics: {
                    network_health: proctoring.network_disconnects === 0 ? "Stable" : "Unstable",
                    ...proctoring
                },
                submissions: enrichedSubmissions,
                suggestions: generateDeepSuggestions(proctoring, isPass),
                debug_configs: {
                    start_config: resultRow?.start_config || {},
                    end_config: resultRow?.end_config || {}
                }
            }
        });

    } catch (e) {
        console.error("Analytics Error:", e);
        res.status(500).json({ error: "SERVER_ERROR", details: e.message });
    }
});


// ====================================================================
// 2. GET UNIT OVERALL COMPLETION (Aggregated Progress)
// ====================================================================
router.post('/analytics/unit-completion', async (req, res) => {
    try {
        const { student_id, course_id, unit_id } = req.body;

        if (!student_id || !course_id || !unit_id) {
            return res.status(400).json({ error: "student_id, course_id, and unit_id are required" });
        }

        // 1. Fetch Unit Metadata (To find all Sub-Units)
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

        // 2. Fetch All Results for this Student & Unit
        const { data: allResults } = await supabase
            .from('results')
            .select('sub_unit_id, result_type, submitted_at')
            .eq('student_id', student_id)
            .eq('unit_id', unit_id)
            .not('submitted_at', 'is', null);

        // 3. Calculate Progress
        let totalProgressSum = 0;
        const breakdown = [];

        subUnitIds.forEach(subId => {
            const meta = subUnitsMap[subId];

            // Check availability in Firebase
            const hasMCQ = meta.mcq !== undefined || (meta['total-mcq-questions'] && meta['total-mcq-questions'] > 0);
            const hasCoding = meta.coding !== undefined || (meta['total-coding-questions'] && meta['total-coding-questions'] > 0);

            // Check submission in Supabase
            const mcqSubmitted = allResults.some(r => r.sub_unit_id === subId && r.result_type === 'mcq');
            const codingSubmitted = allResults.some(r => r.sub_unit_id === subId && r.result_type === 'coding');

            let subUnitPercent = 0;

            if (hasMCQ && hasCoding) {
                if (mcqSubmitted) subUnitPercent += 50;
                if (codingSubmitted) subUnitPercent += 50;
            }
            else if (hasMCQ && !hasCoding) {
                if (mcqSubmitted) subUnitPercent = 100;
            }
            else if (!hasMCQ && hasCoding) {
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

        // 4. Overall Average
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
