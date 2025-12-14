const express = require('express');
const router = express.Router();
const jwt = require('jsonwebtoken');
const cookieParser = require('cookie-parser');
const { createClient } = require('@supabase/supabase-js');
const { initializeApp } = require('firebase/app');
const { getDatabase, ref, get } = require('firebase/database');
require('dotenv').config();

// --- INIT ---
// Ensure these are in your .env
const supabase = createClient(process.env.SUPABASE_URL, process.env.SUPABASE_ANON_KEY);
const JWT_SECRET = process.env.JWT_SECRET || 'super-secret-key-change-in-prod';
const IS_PROD = process.env.NODE_ENV === 'production';

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

// --- MIDDLEWARE ---
// 1. Enable Cookie Parsing for this router
router.use(cookieParser());

// 2. Auth Guard (Middleware to protect routes)
const authenticateAdmin = (req, res, next) => {
    const token = req.cookies.admin_token; // Read from HttpOnly Cookie

    console.log(`[AuthMiddleware] Path: ${req.path}, Cookie Present: ${!!token}`);

    if (!token) {
        return res.status(401).json({ error: "UNAUTHORIZED", path: req.path });
    }

    try {
        const decoded = jwt.verify(token, JWT_SECRET);
        req.user = decoded; // Attach user to request
        next();
    } catch (err) {
        console.error("Token Verification Failed:", err.message);
        return res.status(401).json({ error: "INVALID_TOKEN" });
    }
};


// --- AUTH ROUTES ---

// 1️⃣ LOGIN (Issue Cookie)
router.post('/auth/login', async (req, res) => {
    try {
        const { email, password } = req.body;

        if (!email || !password) {
            return res.status(400).json({ error: "MISSING_CREDENTIALS" });
        }

        // A. Database Lookup
        // Assumes table 'university_admins' exists
        const { data: admin, error } = await supabase
            .from('university_admins')
            .select('admin_id, admin_name, email, university_id, password')
            .eq('email', email)
            .single();

        // B. Password Check (Plain text as requested)
        if (error || !admin || admin.password !== password) {
            return res.status(401).json({ error: "INVALID_CREDENTIALS" });
        }

        // C. Generate JWT
        const token = jwt.sign(
            {
                sub: admin.email,
                name: admin.admin_name,
                universityId: admin.university_id,
                id: admin.admin_id
            },
            JWT_SECRET,
            { expiresIn: '2h' }
        );

        // D. Set HttpOnly Cookie
        res.cookie('admin_token', token, {
            httpOnly: true,
            secure: IS_PROD,           // True in Prod (HTTPS), False in Dev (HTTP)
            sameSite: IS_PROD ? 'None' : 'Lax', // None for Cross-Site (Prod), Lax for Local
            maxAge: 2 * 60 * 60 * 1000 // 2 Hours
        });

        res.json({ success: true, message: "Logged in successfully" });

    } catch (e) {
        console.error("Login Error:", e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

// 2️⃣ ME (Session Check)
router.get('/auth/me', authenticateAdmin, (req, res) => {
    // If we get here, the middleware already validated the token
    res.json({
        email: req.user.sub,
        name: req.user.name,
        universityId: req.user.universityId,
        isAuthenticated: true
    });
});

// 3️⃣ LOGOUT (Clear Cookie)
router.post('/auth/logout', (req, res) => {
    res.cookie('admin_token', '', {
        httpOnly: true,
        secure: true,
        sameSite: 'None',
        expires: new Date(0) // Expire immediately
    });
    res.json({ success: true, message: "Logged out" });
});


// --- PROTECTED ROUTES EXAMPLE ---
// Uses the same `authenticateAdmin` middleware
router.get('/admin/my-batches', authenticateAdmin, async (req, res) => {
    try {
        const { data } = await supabase
            .from('batches')
            .select('*')
            .eq('university_id', req.user.universityId); // Use ID from Token!

        res.json({ success: true, data });
    } catch (e) {
        res.status(500).json({ error: e.message });
    }
});

// --- GET MY TEACHERS (Auto-detected from Cookie) ---
router.get('/admin/my-teachers', authenticateAdmin, async (req, res) => {
    try {
        // 1. Get the ID directly from the secure session (JWT)
        const myUniversityId = req.user.universityId;

        // 2. Fetch teachers for THIS university only
        const { data, error } = await supabase
            .from('teachers_details')
            .select('teacher_id, teacher_name, uni_reg_id, teacher_email, assigned_section')
            .eq('university_id', myUniversityId)
            .order('teacher_name', { ascending: true });

        if (error) throw error;

        res.json({ success: true, data: data || [] });

    } catch (e) {
        console.error("Fetch Teachers Error:", e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});
// --- GET COURSE STRUCTURE WITH ANALYTICS (Firebase + Hardcoded Stats) ---
router.get('/university/admin/course-structure/:courseId', authenticateAdmin, async (req, res) => {
    try {
        const { courseId } = req.params;

        // 1. Fetch Course Units from Firebase
        // Path: EduCode/Courses/{courseId}/units
        const unitsRef = ref(database, `EduCode/Courses/${courseId}/units`);
        const snapshot = await get(unitsRef);

        if (!snapshot.exists()) {
            return res.json({ success: true, data: [] });
        }

        const unitsData = snapshot.val();

        // 2. Transform Data & Add Hardcoded Analytics
        // We convert the Firebase Object (Key-Value) into an Array
        const unitsArray = Object.entries(unitsData).map(([unitId, unitVal]) => {

            // Extract Sub-Units (if any)
            const subUnitsObj = unitVal['sub-units'] || {};
            const subUnitsArray = Object.entries(subUnitsObj).map(([subUnitId, subVal]) => ({
                sub_unit_id: subUnitId,
                title: subVal.title || subVal.name || "Untitled Lecture",
                type: subVal.type || "video" // pdf, video, mcq, coding
            }));

            // 3. HARDCODED ANALYTICS LOGIC
            // User Rule: "Completion rate is only depends on mcq and coding not the pdf"
            // We simulate this by returning high completion for units with coding/mcq
            const isAssessmentUnit = subUnitsArray.some(s => s.type === 'mcq' || s.type === 'coding');

            return {
                unit_id: unitId,
                unit_name: unitVal['unit-name'] || "Untitled Unit",
                total_sub_units: subUnitsArray.length,

                // The Requested Hardcoded Analytics
                analytics: {
                    completion_rate: isAssessmentUnit ? 75 : 0, // 75% if it has assessments
                    average_mcq_score: 82,
                    average_coding_score: 65,
                    status: "In Progress",
                    active_students: 140
                },

                sub_units: subUnitsArray
            };
        });

        res.json({ success: true, data: unitsArray });

    } catch (e) {
        console.error("Fetch Course Structure Error:", e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

// --- GET STUDENTS BY SECTION (With Hardcoded Progress) ---
// --- GET STUDENTS BY SECTION (With Hardcoded Progress) ---
router.get('/admin/students/:section', authenticateAdmin, async (req, res) => {
    try {
        const { section } = req.params;
        const myUniversityId = req.user.universityId; // From Admin Token

        // 1. Fetch Students
        // We use "!inner" to enforce that the batch MUST belong to the Admin's University
        const { data: students, error } = await supabase
            .from('students')
            .select(`
                student_id, 
                student_name, 
                uni_reg_id, 
                section, 
                student_email,
                student_phone,
                batches!inner(university_id) 
            `)
            .eq('section', section)
            .eq('batches.university_id', myUniversityId) // <--- SECURITY LOCK
            .order('student_name', { ascending: true });

        if (error) throw error;

        // 2. Add Hardcoded Progress (As requested)
        const studentsWithProgress = (students || []).map(student => ({
            ...student,
            // Removes the nested 'batches' object from the final response to keep it clean
            batches: undefined,

            // Hardcoded Progress Logic
            progress: {
                completed_lectures: 12,
                total_lectures: 20,
                course_completion_percentage: 60,
                last_active: "2023-12-14"
            }
        }));

        res.json({ success: true, data: studentsWithProgress });

    } catch (e) {
        console.error("Fetch Students Error:", e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

// --- GET COURSE STRUCTURE WITH ANALYTICS (Firebase + Hardcoded Stats) ---
router.get('/admin/course-structure/:courseId', authenticateAdmin, async (req, res) => {
    try {
        const { courseId } = req.params;

        // 1. Fetch Course Units from Firebase
        // Path: EduCode/Courses/{courseId}/units
        const unitsRef = ref(database, `EduCode/Courses/${courseId}/units`);
        const snapshot = await get(unitsRef);

        if (!snapshot.exists()) {
            return res.json({ success: true, data: [] });
        }

        const unitsData = snapshot.val();

        // 2. Transform Data & Add Hardcoded Analytics
        // We convert the Firebase Object (Key-Value) into an Array
        const unitsArray = Object.entries(unitsData).map(([unitId, unitVal]) => {

            // Extract Sub-Units (if any)
            const subUnitsObj = unitVal['sub-units'] || {};
            const subUnitsArray = Object.entries(subUnitsObj).map(([subUnitId, subVal]) => ({
                sub_unit_id: subUnitId,
                title: subVal['sub-unit-name'] || subVal.title || subVal.name || "Untitled Lecture",
                type: subVal.type || "video" // pdf, video, mcq, coding
            }));

            // 3. HARDCODED ANALYTICS LOGIC
            // User Rule: "Completion rate is only depends on mcq and coding not the pdf"
            // We simulate this by returning high completion for units with coding/mcq
            const isAssessmentUnit = subUnitsArray.some(s => s.type === 'mcq' || s.type === 'coding');

            return {
                unit_id: unitId,
                unit_name: unitVal['unit-name'] || "Untitled Unit",
                total_sub_units: subUnitsArray.length,

                // The Requested Hardcoded Analytics
                analytics: {
                    completion_rate: isAssessmentUnit ? 75 : 0, // 75% if it has assessments
                    average_mcq_score: 82,
                    average_coding_score: 65,
                    status: "In Progress",
                    active_students: 140
                },

                sub_units: subUnitsArray
            };
        });

        res.json({ success: true, data: unitsArray });

    } catch (e) {
        console.error("Fetch Course Structure Error:", e);
        res.status(500).json({ error: "SERVER_ERROR" });
    }
});

// --- GET FULL SECTION ANALYTICS (Matrix View) ---
// --- GET SECTION ANALYTICS (Real Students + Real Courses) ---
// --- GET SECTION ANALYTICS MATRIX (Real Data Integration) ---
router.get('/admin/section-analytics/:sectionName', authenticateAdmin, async (req, res) => {
    try {
        const { sectionName } = req.params;
        const myUniversityId = req.user.universityId;

        // ---------------------------------------------------------
        // 1. FETCH STUDENTS & THEIR BATCH INFO
        // ---------------------------------------------------------
        // We join 'batches' to get the 'registered_courses_id' array automatically.
        const { data: students, error: studentError } = await supabase
            .from('students')
            .select(`
                student_id, 
                student_name, 
                uni_reg_id, 
                batch_id,
                batches ( registered_courses_id ) 
            `)
            .eq('section', sectionName)
            .eq('uni_id', myUniversityId)
            .order('student_name', { ascending: true });

        if (studentError) throw studentError;

        if (!students || students.length === 0) {
            return res.json({ success: true, data: { section_metadata: { total_students: 0 }, student_performance: [] } });
        }

        // ---------------------------------------------------------
        // 2. IDENTIFY COURSES FOR THIS SECTION
        // ---------------------------------------------------------
        // Logic: We look at the first student's batch to decide which courses to show.
        // If batch info is missing, we fallback to fetching ALL courses for the university.
        let targetCourseIds = [];

        const firstBatch = students[0].batches;
        if (firstBatch && firstBatch.registered_courses_id && firstBatch.registered_courses_id.length > 0) {
            targetCourseIds = firstBatch.registered_courses_id;
        }

        let courses = [];

        if (targetCourseIds.length > 0) {
            // Fetch only specific courses assigned to this batch
            const { data: fetchedCourses } = await supabase
                .from('courses')
                .select('course_id, course_name')
                .in('course_id', targetCourseIds);
            courses = fetchedCourses || [];
        } else {
            // FALLBACK: Fetch ALL active courses for this university if no batch data exists
            const { data: allCourses } = await supabase
                .from('courses')
                .select('course_id, course_name')
                .eq('university_id', myUniversityId);
            courses = allCourses || [];
        }

        // ---------------------------------------------------------
        // 3. FETCH EXAM RESULTS (THE SCORES)
        // ---------------------------------------------------------
        // We fetch ALL results for these students in one go (Efficient)
        const studentIds = students.map(s => s.student_id);
        const { data: allResults, error: resultError } = await supabase
            .from('results')
            .select('student_id, course_id, marks_obtained, total_marks')
            .in('student_id', studentIds);

        if (resultError) throw resultError;

        // ---------------------------------------------------------
        // 4. CALCULATE AGGREGATES & BUILD RESPONSE
        // ---------------------------------------------------------

        // Helper to store totals for the "Class Average" row
        let courseGrandTotals = {};
        courses.forEach(c => courseGrandTotals[c.course_id] = { sum: 0, count: 0 });

        const studentPerformance = students.map(student => {
            let studentTotalPercent = 0;
            let coursesTakenCount = 0;

            const studentCourses = courses.map(course => {
                // Filter results for this specific student AND course
                // (A student might have multiple results for 1 course, e.g., Unit 1 Test, Unit 2 Test)
                const relevantResults = allResults.filter(r =>
                    r.student_id === student.student_id &&
                    r.course_id === course.course_id
                );

                let scorePercent = 0;
                let status = "N/A";

                if (relevantResults.length > 0) {
                    // Calculate Aggregate Percentage: (Sum Obtained / Sum Total) * 100
                    const totalObtained = relevantResults.reduce((sum, r) => sum + (Number(r.marks_obtained) || 0), 0);
                    const totalMax = relevantResults.reduce((sum, r) => sum + (Number(r.total_marks) || 0), 0);

                    if (totalMax > 0) {
                        scorePercent = Math.round((totalObtained / totalMax) * 100);
                        status = scorePercent >= 40 ? "Pass" : "Fail";

                        // Add to Grand Totals (for Class Average)
                        courseGrandTotals[course.course_id].sum += scorePercent;
                        courseGrandTotals[course.course_id].count += 1;

                        // Add to Student Totals (for Overall Progress)
                        studentTotalPercent += scorePercent;
                        coursesTakenCount++;
                    }
                }

                return {
                    course_id: course.course_id,
                    course_name: course.course_name,
                    score: scorePercent,
                    status: status
                };
            });

            return {
                student_id: student.student_id,
                student_name: student.student_name,
                uni_reg_id: student.uni_reg_id,
                overall_progress: coursesTakenCount > 0 ? Math.round(studentTotalPercent / coursesTakenCount) : 0,
                courses: studentCourses
            };
        });

        // Calculate Final Class Averages (Bottom Row)
        const courseAverages = courses.map(c => {
            const totals = courseGrandTotals[c.course_id];
            return {
                course_id: c.course_id,
                course_name: c.course_name,
                average_score: totals.count > 0 ? Math.round(totals.sum / totals.count) : 0
            };
        });

        res.json({
            success: true,
            data: {
                section_metadata: {
                    section_name: sectionName,
                    total_students: students.length,
                    total_courses: courses.length
                },
                course_performance: courseAverages,
                student_performance: studentPerformance
            }
        });

    } catch (e) {
        console.error("Section Analytics Error:", e);
        res.status(500).json({ error: "SERVER_ERROR", details: e.message });
    }
});

module.exports = router;
