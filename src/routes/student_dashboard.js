const express = require('express');
const router = express.Router();
const { createClient } = require('@supabase/supabase-js');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get } = require('firebase/database');
const XLSX = require('xlsx');
require('dotenv').config();

// Initialize Supabase
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);

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
const firebaseApp = initializeApp(firebaseConfig);
const database = getDatabase(firebaseApp);

// --- UTILITY FUNCTIONS (Internal Logic) ---
const PASS_THRESHOLD = 0.5; // 50%

const toObject = (val) => {
    if (!val) return null;
    if (typeof val === 'object') return val;
    try { return JSON.parse(val); } catch (e) { return null; }
};

const percentFrom = (score, total) => {
    if (!total || total === 0) return 0;
    return Math.round((score / total) * 100);
};

const timeTakenSecondsFromAnalytics = (analytics) => {
    if (!analytics || !analytics.startedAt || !analytics.lastUpdatedAt) return null;
    const start = new Date(analytics.startedAt).getTime();
    const end = new Date(analytics.lastUpdatedAt).getTime();
    return Math.max(0, Math.round((end - start) / 1000));
};

const computeAvgPctByAttempt = (rows = []) => {
    const map = new Map();
    rows.forEach((r) => {
        const a = toObject(r.analytics);
        let score = 0, total = 0;
        if (a?.mcq && typeof a.mcq.score === 'number') {
            score = a.mcq.score; total = a.mcq.total;
        } else {
            score = Number(r.marks_obtained) || 0;
            total = Number(r.total_marks) || 0;
        }
        const pct = percentFrom(score, total);
        const att = Number(r.attempt_count) || 0;

        if (!map.has(att)) map.set(att, { sumPct: 0, count: 0 });
        const m = map.get(att);
        m.sumPct += pct;
        m.count += 1;
    });

    const attempts = Array.from(map.keys()).sort((a, b) => a - b);
    const avgPct = attempts.map((a) => {
        const m = map.get(a);
        return m.count > 0 ? Math.round(m.sumPct / m.count) : 0;
    });
    return { attempts, avgPct };
};

// --- DATA FETCHING HELPERS ---

const fetchStudents = async (viewType, ident) => {
    let q = supabase.from('students').select('student_id, student_name, uni_reg_id, section, batch_id');
    if (viewType === 'batch') q = q.eq('batch_id', ident);
    else if (viewType === 'section') q = q.eq('section', ident);
    else q = q.eq('uni_reg_id', ident);

    const { data, error } = await q;
    if (error) throw error;
    return data || [];
};

const fetchResults = async (courseId, unitId, subUnitId, resultType, studentIds) => {
    if (studentIds.length === 0) return [];
    const { data, error } = await supabase
        .from('results')
        .select('*')
        .eq('course_id', courseId)
        .eq('unit_id', unitId)
        .eq('sub_unit_id', subUnitId)
        .eq('result_type', resultType)
        .in('student_id', studentIds)
        .order('attempt_count', { ascending: false });

    if (error) throw error;
    return data || [];
};

// --- API ENDPOINTS ---

// 1. GET MASTERS (Batches & Sections)
router.get('/masters/batches', async (req, res) => {
    try {
        const { data, error } = await supabase.from('batches').select('batch_id, batch_name');
        if (error) throw error;
        res.json({ success: true, data: data || [] });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

router.get('/masters/sections', async (req, res) => {
    try {
        const { data, error } = await supabase.from('students').select('section').not('section', 'is', null);
        if (error) throw error;
        const sections = [...new Set((data || []).map(s => s.section))].sort();
        res.json({ success: true, data: sections });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 2. GET COURSE STRUCTURE
// router.get('/courses/:batchId', async (req, res) => {
//     try {
//         const { batchId } = req.params;
//         const { data: batchData, error: batchError } = await supabase
//             .from('batches')
//             .select('registered_courses_id')
//             .eq('batch_id', batchId)
//             .single();

//         if (batchError || !batchData) throw new Error('Batch not found');

//         const { data: courses, error: courseError } = await supabase
//             .from('courses')
//             .select('course_id, course_name')
//             .in('course_id', batchData.registered_courses_id || []);

//         if (courseError) throw courseError;
//         res.json({ success: true, data: courses });
//     } catch (e) {
//         res.status(500).json({ success: false, error: e.message });
//     }
// });

router.get('/structure/:courseId', async (req, res) => {
    try {
        const { courseId } = req.params;
        const { unitId } = req.query; // Optional

        if (unitId) {
            const snapshot = await get(ref(database, `EduCode/Courses/${courseId}/units/${unitId}/sub-units`));
            const data = snapshot.exists() ? Object.entries(snapshot.val()).map(([id, val]) => ({ id, ...val })) : [];
            return res.json({ success: true, data });
        }

        const snapshot = await get(ref(database, `EduCode/Courses/${courseId}/units`));
        const data = snapshot.exists() ? Object.entries(snapshot.val()).map(([id, val]) => ({ id, ...val })) : [];
        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 3. LOOKUP (Student/Section -> Batch)
router.post('/lookup', async (req, res) => {
    try {
        const { type, value } = req.body;
        let result = null;

        if (type === 'uni_reg_id') {
            const { data } = await supabase.from('students').select('batch_id, student_id, student_name').eq('uni_reg_id', value).single();
            result = data;
        } else if (type === 'section') {
            const { data } = await supabase.from('students').select('batch_id').eq('section', value).limit(1).single();
            result = data;
        }

        if (!result) return res.status(404).json({ success: false, message: 'Not found' });
        res.json({ success: true, data: result });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 4. MAIN ANALYTICS DASHBOARD (Summary & Table)
router.post('/analytics/summary', async (req, res) => {
    try {
        const { viewType, identifier, courseId, unitId, subUnitId } = req.body;

        // 1. Fetch Students
        const students = await fetchStudents(viewType, identifier);
        const studentIds = students.map(s => s.student_id);

        // 2. Fetch Results in Parallel (Optimization)
        const [mcqResults, codingResults, courseData] = await Promise.all([
            fetchResults(courseId, unitId, subUnitId, 'mcq', studentIds),
            fetchResults(courseId, unitId, subUnitId, 'coding', studentIds),
            supabase.from('courses').select('course_name').eq('course_id', courseId).single()
        ]);

        // 3. Process Summary Logic
        // Helper to find latest attempt per student
        const getLatest = (rows) => {
            const map = new Map();
            rows.forEach(r => {
                if (!map.has(r.student_id) || (map.get(r.student_id).attempt_count < r.attempt_count)) {
                    map.set(r.student_id, r);
                }
            });
            return Array.from(map.values());
        };

        const latestMcq = getLatest(mcqResults);
        const latestCoding = getLatest(codingResults);

        // Calc Pass/Fail
        const calcStats = (list) => {
            let pass = 0, fail = 0;
            list.forEach(r => {
                const a = toObject(r.analytics);
                let score = a?.mcq ? a.mcq.score : (Number(r.marks_obtained) || 0);
                let total = a?.mcq ? a.mcq.total : (Number(r.total_marks) || 0);
                if (percentFrom(score, total) >= PASS_THRESHOLD * 100) pass++; else fail++;
            });
            return { pass, fail };
        };

        const mcqSummary = calcStats(latestMcq);
        const codingSummary = calcStats(latestCoding);

        // Calc Averages
        const allLatest = [...latestMcq, ...latestCoding];
        let sums = { time: 0, face: 0, lost: 0, disc: 0 };
        let counts = { time: 0, face: 0, lost: 0, disc: 0 };

        allLatest.forEach(r => {
            const a = toObject(r.analytics) || {};
            const t = timeTakenSecondsFromAnalytics(a);
            if (t !== null) { sums.time += t; counts.time++; }
            if (typeof a.faceWarnings === 'number') { sums.face += a.faceWarnings; counts.face++; }
            if (typeof a.lostFocusCount === 'number') { sums.lost += a.lostFocusCount; counts.lost++; }
            if (typeof a.internetDisconnects === 'number') { sums.disc += a.internetDisconnects; counts.disc++; }
        });

        const avg = (k) => counts[k] > 0 ? sums[k] / counts[k] : 0;

        // Generate Improvements
        const improvements = [];
        if (avg('face') > 10) improvements.push('High face warnings detected. Advise better lighting.');
        if (avg('lost') > 3) improvements.push('Frequent focus changes detected.');
        if (avg('disc') > 0.5) improvements.push('Connectivity issues observed.');
        if (counts.time > 0 && avg('time') > 900) improvements.push('Students are taking too long per attempt.');

        const summaryData = {
            mcq: mcqSummary,
            coding: codingSummary,
            averages: {
                time: avg('time'),
                faceWarnings: avg('face'),
                lostFocus: avg('lost'),
                disconnects: avg('disc')
            },
            trends: {
                mcq: computeAvgPctByAttempt(mcqResults),
                coding: computeAvgPctByAttempt(codingResults)
            },
            improvements
        };

        // 4. Process Table Rows
        const courseName = courseData.data?.course_name || courseId;
        const tableData = students.map(s => {
            const sMcq = mcqResults.filter(r => r.student_id === s.student_id).sort((a, b) => b.attempt_count - a.attempt_count)[0];
            const sCoding = codingResults.filter(r => r.student_id === s.student_id).sort((a, b) => b.attempt_count - a.attempt_count)[0];
            const analyticsObj = toObject((sMcq || sCoding)?.analytics);

            return {
                student_id: s.student_id,
                uni_reg_id: s.uni_reg_id,
                student_name: s.student_name,
                section: s.section,
                course_name: courseName,
                mcq_marks: sMcq ? `${sMcq.marks_obtained}/${sMcq.total_marks}` : 'N/A',
                coding_marks: sCoding ? `${sCoding.marks_obtained}/${sCoding.total_marks}` : 'N/A',
                analytics: analyticsObj,
                submit_reason: analyticsObj?.submitReason || null
            };
        });

        res.json({ success: true, summary: summaryData, table: tableData });

    } catch (e) {
        console.error(e);
        res.status(500).json({ success: false, error: e.message });
    }
});

// 5. EXPORT TO EXCEL
router.post('/export/excel', async (req, res) => {
    try {
        // Expects the exact same body as summary, plus specific keys for the file
        const { viewType, identifier, courseId, unitId, subUnitId } = req.body;

        // ... (Reusing Fetch Logic - in production, extract this to a shared function) ...
        // For brevity, assuming we fetched data into variables: students, mcqResults, codingResults
        const students = await fetchStudents(viewType, identifier);
        const studentIds = students.map(s => s.student_id);
        const [mcqResults, codingResults, courseData] = await Promise.all([
            fetchResults(courseId, unitId, subUnitId, 'mcq', studentIds),
            fetchResults(courseId, unitId, subUnitId, 'coding', studentIds),
            supabase.from('courses').select('course_name').eq('course_id', courseId).single()
        ]);

        const courseName = courseData.data?.course_name || '';

        // Create Workbook
        const wb = XLSX.utils.book_new();

        // -- Sheet 1: Summary --
        const summaryRows = students.map(s => {
            const sMcq = mcqResults.find(r => r.student_id === s.student_id && r.attempt_count === 1) || {}; // Simplified for export example
            return {
                RegID: s.uni_reg_id,
                Name: s.student_name,
                Section: s.section,
                Course: courseName,
                // ... Add all other flattened fields here
            };
        });
        const wsSummary = XLSX.utils.json_to_sheet(summaryRows);
        XLSX.utils.book_append_sheet(wb, wsSummary, "Summary");

        // -- Sheet 2: Attempts -- 
        // (Add logic similar to original function)

        // Generate Buffer
        const buf = XLSX.write(wb, { type: 'buffer', bookType: 'xlsx' });

        res.setHeader('Content-Disposition', `attachment; filename="Report.xlsx"`);
        res.setHeader('Content-Type', 'application/vnd.openxmlformats-officedocument.spreadsheetml.sheet');
        res.send(buf);

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 6. INDIVIDUAL STUDENT HISTORY
router.post('/student/history', async (req, res) => {
    try {
        const { uniRegId, courseId, unitId, subUnitId, resultType } = req.body;

        const { data: student } = await supabase.from('students').select('student_id').eq('uni_reg_id', uniRegId).single();
        if (!student) throw new Error('Student not found');

        const results = await fetchResults(courseId, unitId, subUnitId, resultType, [student.student_id]);

        // Calculate Trends
        const attempts = [...new Set(results.map(r => r.attempt_count))].sort((a, b) => a - b);
        const pctArr = [];

        results.sort((a, b) => a.attempt_count - b.attempt_count).forEach(r => {
            const score = Number(r.marks_obtained) || 0;
            const total = Number(r.total_marks) || 0;
            pctArr.push(percentFrom(score, total));
        });

        res.json({
            success: true,
            data: {
                results,
                attempts,
                pctTrend: pctArr
            }
        });
    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});

// 7. ATTEMPT DETAILED VIEW (Deep Dive)
router.post('/student/attempt-details', async (req, res) => {
    try {
        const { uniRegId, courseId, unitId, subUnitId, attempt, resultType } = req.body;

        // 1. Get Student ID
        const { data: student } = await supabase.from('students').select('student_id').eq('uni_reg_id', uniRegId).single();
        if (!student) throw new Error('Student not found');
        const studentId = student.student_id;

        // 2. Fetch Result, Submissions, Question IDs in Parallel
        const submissionPromise = supabase.from('student_submission')
            .select('*')
            .match({ student_id: studentId, course_id: courseId, unit_id: unitId, sub_unit_id: subUnitId, attempt });

        const resultPromise = supabase.from('results')
            .select('*')
            .match({ student_id: studentId, course_id: courseId, unit_id: unitId, sub_unit_id: subUnitId, result_type: resultType, attempt_count: attempt })
            .single();

        const [subRes, resRes] = await Promise.all([submissionPromise, resultPromise]);

        if (subRes.error) throw subRes.error;

        const submissions = subRes.data || [];
        const questionIds = [...new Set(submissions.map(s => s.question_id))];

        // 3. Fetch Question Content from Firebase
        // Optimization: Fetch all needed questions in parallel
        const questionDetails = {};
        const questionPromises = questionIds.map(async (qid) => {
            const snapshot = await get(ref(database, `EduCode/Courses/${courseId}/units/${unitId}/sub-units/${subUnitId}/${resultType}/${qid}`));
            if (snapshot.exists()) {
                return { id: qid, ...snapshot.val() };
            }
            return null;
        });

        const questionsArray = await Promise.all(questionPromises);
        questionsArray.forEach(q => { if (q) questionDetails[q.id] = q; });

        res.json({
            success: true,
            data: {
                result: resRes.data,
                submissions,
                questions: questionDetails
            }
        });

    } catch (e) {
        res.status(500).json({ success: false, error: e.message });
    }
});


// ====================================================================
// GET SECTION EXAM PROGRESS & SYSTEM DETAILS
// ====================================================================
router.post('/teacher/analytics/section-exam-progress', async (req, res) => {
    try {
        const { course_id, section_name, university_id } = req.body;

        if (!course_id || !section_name) {
            return res.status(400).json({ error: "course_id and section_name are required" });
        }

        // ---------------------------------------------------------
        // 1. FETCH STUDENTS IN SECTION
        // ---------------------------------------------------------
        const { data: students, error: studentError } = await supabase
            .from('students')
            .select('student_id, student_name, uni_reg_id')
            .eq('section', section_name)
            .eq('uni_id', university_id); // Security check

        if (studentError) throw studentError;

        if (!students || students.length === 0) {
            return res.json({
                success: true,
                data: {
                    section_name,
                    total_students: 0,
                    students: []
                }
            });
        }

        const studentIds = students.map(s => s.student_id);

        // ---------------------------------------------------------
        // 2. BUILD "EXAM BLUEPRINT" FROM FIREBASE
        // ---------------------------------------------------------
        let examBlueprint = []; // Stores only 'exam' sub-units
        
        try {
            const courseRef = ref(database, `EduCode/Courses/${course_id}/units`);
            const snap = await get(courseRef);
            
            if (snap.exists()) {
                const unitsData = snap.val();
                
                Object.keys(unitsData).forEach(unitKey => {
                    const subUnits = unitsData[unitKey]['sub-units'] || {};
                    
                    Object.keys(subUnits).forEach(subKey => {
                        const subMeta = subUnits[subKey];
                        
                        // STRICT FILTER: Only 'exam' type
                        if (subMeta['sub_type'] === 'exam') {
                            
                            // Check content availability
                            const hasMCQ = subMeta.mcq !== undefined || (subMeta['total-mcq-questions'] && subMeta['total-mcq-questions'] > 0);
                            const hasCoding = subMeta.coding !== undefined || (subMeta['total-coding-questions'] && subMeta['total-coding-questions'] > 0);

                            if (hasMCQ || hasCoding) {
                                examBlueprint.push({
                                    sub_unit_id: subKey,
                                    sub_unit_title: subMeta['sub-unit-name'] || "Exam",
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
        // 3. BULK FETCH EXAM RESULTS (Postgres)
        // ---------------------------------------------------------
        const { data: allResults } = await supabase
            .from('results')
            .select('student_id, sub_unit_id, result_type, submitted_at, start_config, end_config')
            .in('student_id', studentIds)
            .eq('course_id', course_id)
            .not('submitted_at', 'is', null);

        // Map for fast lookup: "studentID_subUnitID_type" -> Result Object
        const resultMap = new Map();
        (allResults || []).forEach(r => {
            resultMap.set(`${r.student_id}_${r.sub_unit_id}_${r.result_type}`, r);
        });

        // ---------------------------------------------------------
        // 4. CALCULATE PROGRESS & EXTRACT CONFIGS
        // ---------------------------------------------------------
        const studentProgressList = students.map(student => {
            let totalProgressSum = 0;
            let lastStartConfig = null;
            let lastEndConfig = null;

            // Iterate through every Exam Sub-Unit defined in the course
            examBlueprint.forEach(examItem => {
                let itemProgress = 0;
                
                // Keys for lookup
                const mcqKey = `${student.student_id}_${examItem.sub_unit_id}_mcq`;
                const codingKey = `${student.student_id}_${examItem.sub_unit_id}_coding`;

                // Retrieve Results
                const mcqResult = resultMap.get(mcqKey);
                const codingResult = resultMap.get(codingKey);

                const didMCQ = !!mcqResult;
                const didCoding = !!codingResult;

                // Capture Configs (Prioritize Coding, then MCQ, update if found)
                if (didCoding) {
                    if (codingResult.start_config) lastStartConfig = codingResult.start_config;
                    if (codingResult.end_config) lastEndConfig = codingResult.end_config;
                } else if (didMCQ) {
                    if (mcqResult.start_config) lastStartConfig = mcqResult.start_config;
                    if (mcqResult.end_config) lastEndConfig = mcqResult.end_config;
                }

                // 50/50 Logic
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

            // Average Progress across all exams
            const examAvg = Math.round(totalProgressSum / totalExamItems);

            return {
                student_name: student.student_name,
                uni_reg_id: student.uni_reg_id,
                exam_completion_percentage: examAvg,
                // System details from the latest/most relevant exam attempt
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
