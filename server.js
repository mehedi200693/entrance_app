const express = require('express');
const mysql = require('mysql2');
const cors = require('cors');
const bodyParser = require('body-parser');

const app = express();
app.use(cors());
app.use(express.json());

// 🔌 মাইএসকিউএল ডাটাবেজ কানেকশন
const db = mysql.createPool({
    host: 'mysql-1af9ddc7-entrance-new-app-01.l.aivencloud.com',
    port: '17828',
    user: 'avnadmin',      
    password: 'AVNS_sCS8XkTeBd3b9lqDTff',      
    database: '',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,

ssl: {
    rejectUnauthorized: false

}
});


db.getConnection((err, connection) => {
    if (err) {
        console.log("ডাটাবেজ কানেকশনে সমস্যা:", err);
    } else {
        console.log("ডাটাবেজプール এর সাথে সফলভাবে কানেক্ট হয়েছে!");
        connection.release();
    }
});

// 💡 ফিক্স ১: টার্গেট অ্যামাউন্ট ০ না দেখিয়ে আসল টার্গেট দেখানোর লজিক
const sanitizeData = (results) => {
    return results.map(row => ({
        ...row,
        // যদি কালেকশন ০ থাকে, তবে ডিফল্টভাবে আজকের টার্গেট দেখাবে, নয়তো কালেকশনটাই দেখাবে
        collected: (row.collected == null || row.collected == 0) ? (row.targetToday ?? 0) : row.collected,
        savingsInput: (row.savingsInput == null || row.savingsInput == 0) ? (row.savingsTarget ?? 0) : row.savingsInput,
        targetToday: row.targetToday ?? 0,
        savingsTarget: row.savingsTarget ?? 0,
        totalSavings: row.totalSavings ?? 0,
        totalDue: row.totalDue ?? 0,
        accumulatedDue: row.accumulatedDue ?? 0
    }));
};

// 🔐 ১. মাল্টি-কোম্পানি লগইন API
app.post('/api/login', (req, res) => {
    const { username, password } = req.body;
    const sql = "SELECT company_id, username, name, role FROM users WHERE username = ? AND password = ? AND status = 'Active'";
    db.query(sql, [username, password], (err, results) => {
        if (err) return res.status(500).json({ error: "সার্ভার এরর!" });
        if (results.length === 0) return res.status(401).json({ error: "ইউজার আইডি বা পাসওয়ার্ড ভুল!" });
        res.status(200).json({ message: "সফল লগইন", user: results[0] });
    });
});

// 📅 ২. সিস্টেম তারিখ জানার API 
app.get('/api/get-system-date', (req, res) => {
    let companyId = req.query.company_id || 'COM101'; // 💡 ফিক্স: ডিফল্ট COM101
    
    const sql = "SELECT DATE_FORMAT(system_date, '%Y-%m-%d') as s_date FROM system_settings WHERE company_id = ?";
    db.query(sql, [companyId], (err, results) => {
        if (err || results.length === 0) {
            const fallbackDate = new Date().toISOString().split('T')[0];
            return res.status(200).json({ current_date: fallbackDate, system_date: fallbackDate, date: fallbackDate });
        }
        
        const dbDate = results[0].s_date;
        res.status(200).json({ current_date: dbDate, system_date: dbDate, date: dbDate });
    });
});

// 📥 ৩. কালেকশন শিট ডাটা API
app.get('/api/get-collection-data', (req, res) => {
    // 💡 এখানে sanitizeData ফাংশন ব্যবহার করায় কিস্তির ঘরে এখন টার্গেট এম্যাউন্ট অটো বসে যাবে
    const sql = "SELECT * FROM active_loans WHERE status = 'Active' AND isSavedToday = 'false'";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: "ডাটা আনতে সমস্যা হয়েছে।" });
        res.status(200).json(sanitizeData(results));
    });
});
//3.1
app.get('/api/print-financial-report', (req, res) => {
    const company_id = req.query.company_id;
    const from_date = req.query.from_date;
    const to_date = req.query.to_date;

    // কুয়েরি ১: active_loans থেকে বর্তমানের লাইভ ক্লোজিং ডাটা আনা হচ্ছে (C)
    db.query(`
        SELECT 
            COUNT(id) as total_members,
            SUM(totalSavings) as total_savings, 
            SUM(totalDue) as total_due 
        FROM active_loans
        WHERE company_id = ?
    `, [company_id], (err, closingRows) => {
        
        if (err) return res.status(500).send("Database Error (closing): " + err.message);

        // কুয়েরি ২: daily_top_sheets থেকে নির্দিষ্ট তারিখের রেগুলার লেনদেন আনা হচ্ছে (B)
        db.query(`
            SELECT 
                SUM(total_collection) as sum_recovery,
                SUM(total_savings) as sum_savings,
                SUM(total_withdraw) as sum_withdraw
            FROM daily_top_sheets
            WHERE company_id = ? AND date BETWEEN ? AND ?
        `, [company_id, from_date, to_date], (err, dailyRows) => {

            if (err) return res.status(500).send("Database Error (daily): " + err.message);

            // কুয়েরি ৩: active_loans থেকে নির্দিষ্ট তারিখের নতুন লোন বিতরণের ডাটা আনা হচ্ছে
            db.query(`
                SELECT 
                    SUM(disburseAmount) as sum_new_loans 
                FROM active_loans 
                WHERE company_id = ? AND disburseDate BETWEEN ? AND ?
            `, [company_id, from_date, to_date], (err, loanRows) => {

                if (err) return res.status(500).send("Database Error (disbursement): " + err.message);

                const dbClosing = closingRows && closingRows[0] ? closingRows[0] : {};
                const dbDaily = dailyRows && dailyRows[0] ? dailyRows[0] : {};
                const dbLoan = loanRows && loanRows[0] ? loanRows[0] : {};

                // লোন বিতরণের হিসাব
                const loan_disbursed_principal = Number(dbLoan.sum_new_loans) || 0; 
                const loan_disbursed_with_profit = loan_disbursed_principal > 0 ? loan_disbursed_principal * 1.20 : 0; 
                const loan_recovery = Number(dbDaily.sum_recovery) || 0; 
                const net_loan_change = loan_disbursed_with_profit - loan_recovery;

                // সঞ্চয়ের হিসাব
                const regular_savings = Number(dbDaily.sum_savings) || 0;
                const disburse_savings_deduction = loan_disbursed_principal * 0.10; 
                const total_savings_collection = regular_savings + disburse_savings_deduction; 
                
                const savings_refund = Number(dbDaily.sum_withdraw) || 0;
                const net_savings_change = total_savings_collection - savings_refund;

                // ক্লোজিং ব্যালেন্স (লাইভ ডাটা)
                const closing_members = dbClosing.total_members || 0;
                const closing_savings = dbClosing.total_savings || 0;
                const closing_loan = dbClosing.total_due || 0;

                // ওপেনিং ব্যালেন্স
                const opening_members = closing_members; 
                const opening_savings = closing_savings - net_savings_change;
                const opening_loan = closing_loan - net_loan_change;

                const data = {
                    company_name: "Entrance Multipurpose Co-operative Society Ltd.",
                    branch: "Branch: 01 (Banasree Branch)",
                    address: "South Banasree, Khilgaon, Dhaka-1219",
                    date_range: `Date: ${from_date} to ${to_date}`,
                    
                    opening: { 
                        members: opening_members, 
                        savings_os: Math.round(opening_savings), 
                        loan_due: Math.round(opening_loan), 
                        loan_os: Math.round(opening_loan) 
                    },
                    during: { 
                        new_members: 0, 
                        dropouts: 0, 
                        savings_col: Math.round(total_savings_collection), 
                        savings_ref: Math.round(savings_refund), 
                        disbursed_qty: loan_disbursed_principal > 0 ? 1 : 0, 
                        disbursed_amt: Math.round(loan_disbursed_principal), 
                        recovery: Math.round(loan_recovery) 
                    },
                    closing: { 
                        members: closing_members, 
                        savings_os: Math.round(closing_savings), 
                        loan_due: Math.round(closing_loan), 
                        loan_os: Math.round(closing_loan) 
                    }
                };

                const htmlResponse = `
                    <!DOCTYPE html>
                    <html>
                    <head>
                        <meta charset="UTF-8">
                        <title>Financial Top Sheet Report</title>
                        <style>
                            body { font-family: Arial, sans-serif; font-size: 11px; margin: 20px; color: #000; }
                            .header { text-align: center; margin-bottom: 25px; border-bottom: 1px solid #000; padding-bottom: 10px; }
                            .header h2 { margin: 0; font-size: 18px; font-weight: bold; }
                            .header p { margin: 3px 0; font-size: 12px; }
                            table { width: 100%; border-collapse: collapse; margin-bottom: 20px; }
                            th, td { border: 1px solid #000; padding: 6px; text-align: center; }
                            th { background-color: #f2f2f2; font-weight: bold; }
                            .section-header { font-weight: bold; border-bottom: 2px solid #000; padding: 4px 0; margin-top: 15px; margin-bottom: 5px; font-size: 12px; text-align: left; }
                        </style>
                    </head>
                    <body>
                        <div class="header">
                            <h2>${data.company_name}</h2>
                            <p>${data.branch}</p>
                            <p>${data.address}</p>
                            <p><strong>${data.date_range}</strong></p>
                        </div>
                        <div class="section-header">A: Opening Balance</div>
                        <table>
                            <tr><th>Total Members</th><th>Savings Outstanding</th><th>Loan Due</th><th>Loan Outstanding</th></tr>
                            <tr><td>${data.opening.members}</td><td>৳${data.opening.savings_os}</td><td>৳${data.opening.loan_due}</td><td>৳${data.opening.loan_os}</td></tr>
                        </table>
                        <div class="section-header">B: During This Period (Savings & Collection)</div>
                        <table>
                            <tr><th>New Members</th><th>Dropouts</th><th>Savings Collection</th><th>Savings Refund</th><th>Loan Disbursed</th><th>Recovery</th></tr>
                            <tr><td>${data.during.new_members}</td><td>${data.during.dropouts}</td><td>৳${data.during.savings_col}</td><td>৳${data.during.savings_ref}</td><td>৳${data.during.disbursed_amt}</td><td>৳${data.during.recovery}</td></tr>
                        </table>
                        <div class="section-header">C: Closing Balance</div>
                        <table>
                            <tr><th>Closing Members</th><th>Closing Savings OS</th><th>Closing Loan Due</th><th>Closing Loan OS</th></tr>
                            <tr><td><strong>${data.closing.members}</strong></td><td><strong>৳${data.closing.savings_os}</strong></td><td><strong>৳${data.closing.loan_due}</strong></td><td><strong>৳${data.closing.loan_os}</strong></td></tr>
                        </table>
                        <script>window.onload = function() { window.print(); };</script>
                    </body>
                    </html>
                `;
                res.send(htmlResponse);
            });
        });
    });
});

// 💾 ৪. কালেকশন শিটের অফলাইন/ড্রাফট সাবমিট
app.post('/api/save-draft-collection', (req, res) => {
    const { members } = req.body;
    if (!members || members.length === 0) return res.status(400).json({ error: "পর্যাপ্ত ডাটা নেই!" });

    let completedQueries = 0;
    let hasError = false;

    members.forEach((member) => {
        const kisti = parseFloat(member.collected || member.installment_collected || 0);
        const sanchay = parseFloat(member.savingsInput || member.savings_collected || 0);

        const sql = `UPDATE active_loans SET collected = ?, savingsInput = ?, isSavedToday = 'true' WHERE id = ?`;
        db.query(sql, [kisti, sanchay, member.id], (err) => {
            if (err) hasError = true;
            completedQueries++;
            if (completedQueries === members.length) {
                if (hasError) return res.status(500).json({ error: "কিছু সদস্যের ডাটা সেভ করা যায়নি!" });
                res.status(200).json({ message: "সচলভাবে সেভ হয়েছে!" });
            }
        });
    });
});

// 📥 ৫. ফাইনাল সাবমিট রুমে ডাটা আনার API 
app.get('/api/get-final-submit-data', (req, res) => {
    const sql = `SELECT * FROM active_loans WHERE status = 'Active' AND (isSavedToday = 'true' OR isSavedToday = 'locked')`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: "ডাটা আনতে সমস্যা হয়েছে!" });
        res.status(200).json(sanitizeData(results));
    });
});

// 💸 ৬. সঞ্চয় উত্তোলন (Withdraw) API 
app.post('/api/savings/withdraw', (req, res) => {
    const { member_id, withdraw_amount, date } = req.body;
    const checkSql = "SELECT totalSavings, name FROM active_loans WHERE id = ?";
    db.query(checkSql, [member_id], (err, results) => {
        if (err || results.length === 0) return res.status(400).json({ error: "সদস্য পাওয়া যায়নি" });
        
        const currentSavings = parseFloat(results[0].totalSavings || 0);
        if (currentSavings < withdraw_amount) return res.status(400).json({ error: "পর্যাপ্ত সঞ্চয় ব্যালেন্স নেই!" });

        const updateSql = "UPDATE active_loans SET totalSavings = totalSavings - ? WHERE id = ?";
        db.query(updateSql, [withdraw_amount, member_id], (err) => {
            if (err) return res.status(500).json({ error: "আপডেট ব্যর্থ হয়েছে" });

            const historySql = "INSERT INTO loan_history (member_id, date, type, gs_w, balance_effect) VALUES (?, ?, 'সঞ্চয় উত্তোলন', ?, ?)";
            db.query(historySql, [member_id, date, withdraw_amount, `-৳${withdraw_amount}`], () => {
                res.status(200).json({ message: "উত্তোলন সফল হয়েছে!" });
            });
        });
    });
});

// 📅 ৭. ফিল্টারড লাইভ লেজার স্টেটমেন্ট
app.get('/api/loan/history-filtered', (req, res) => {
    const { member_id, from_date, to_date } = req.query;
    const sql = `SELECT * FROM loan_history WHERE member_id = ? AND date BETWEEN ? AND ? ORDER BY id DESC`;
    db.query(sql, [member_id, from_date, to_date], (err, results) => {
        if (err) return res.status(500).json({ error: "হিস্টোরি ডাটা পাওয়া যায়নি" });
        res.status(200).json(results);
    });
});

// ৮. ফাইনাল অনলাইন সাবমিট ও বকেয়া হিসাবের মাস্টার API
app.post('/api/lock-collection', (req, res) => {
    const { members, date, company_id } = req.body;
    const cid = company_id || 'COM101'; 

    const getDateSql = "SELECT DATE_FORMAT(system_date, '%Y-%m-%d') as s_date FROM system_settings WHERE company_id = ?";

    db.query(getDateSql, [cid], (dateErr, dateResults) => {
        let safeDate;
        if (dateErr || dateResults.length === 0) {
            safeDate = date || new Date().toISOString().split('T')[0];
        } else {
            safeDate = dateResults[0].s_date; 
        }

        const memberIds = members.map(m => m.id);
        if (memberIds.length === 0) return res.status(200).json({ message: "কোন সদস্য নেই!" });

        const checkLockedSql = "SELECT id, isSavedToday FROM active_loans WHERE id IN (?)";
        db.query(checkLockedSql, [memberIds], (checkErr, dbMembers) => {
            if (checkErr) return res.status(500).json({ error: "ডাটাবেজ চেকিং এরর!" });

            const pendingMembers = members.filter(frontendMember => {
                const dbMember = dbMembers.find(m => m.id === frontendMember.id);
                return dbMember && dbMember.isSavedToday !== 'locked'; 
            });

            if (pendingMembers.length === 0) {
                return res.status(200).json({ message: "এই সদস্যগুলো আগেই সাবমিট করা হয়েছে।" });
            }

            let actual_new_collection = 0;
            let actual_new_savings = 0;

            pendingMembers.forEach(m => {
                actual_new_collection += parseFloat(m.collected || 0);
                actual_new_savings += parseFloat(m.savingsInput || 0);
            });

            const topSheetSql = `INSERT INTO daily_top_sheets (company_id, date, total_collection, total_savings) 
                                 VALUES (?, ?, ?, ?) 
                                 ON DUPLICATE KEY UPDATE 
                                 total_collection = total_collection + VALUES(total_collection), 
                                 total_savings = total_savings + VALUES(total_savings)`;
            
            db.query(topSheetSql, [cid, safeDate, actual_new_collection, actual_new_savings], (topErr) => {
                if (topErr) return res.status(500).json({ error: "টপশিট এরর।" });

                let completedQueries = 0;
                let hasError = false;

                pendingMembers.forEach((member) => {
                    const kisti = parseFloat(member.collected || 0);
                    const sanchay = parseFloat(member.savingsInput || 0);
                    const targetToday = parseFloat(member.targetToday || 0);
                    const todaysDue = targetToday > kisti ? (targetToday - kisti) : 0; 

                    const updateMemberSql = `UPDATE active_loans 
                                             SET totalSavings = totalSavings + ?, 
                                                 totalDue = totalDue - ?, 
                                                 accumulatedDue = accumulatedDue + ?,
                                                 isSavedToday = 'locked', 
                                                 type = (CASE WHEN (totalDue - ?) <= 0 THEN 'Savings Only' ELSE type END)
                                             WHERE id = ?`;
                    
                    db.query(updateMemberSql, [sanchay, kisti, todaysDue, kisti, member.id], (err, updateResult) => {
                        if (err) hasError = true;
                        
                        if (updateResult && updateResult.affectedRows > 0) {
                            const histSql = "INSERT INTO loan_history (member_id, date, type, collected, savings, balance_effect) VALUES (?, ?, 'নিয়মিত আদায়', ?, ?, ?)";
                            db.query(histSql, [member.id, safeDate, kisti, sanchay, `+৳${kisti + sanchay}`], () => {
                                checkAndFinish();
                            });
                        } else {
                            checkAndFinish();
                        }

                        function checkAndFinish() {
                            completedQueries++;
                            if (completedQueries === pendingMembers.length) {
                                if (hasError) return res.status(500).json({ error: "কিছু ডাটা প্রসেস করা যায়নি!" });
                                res.status(200).json({ message: "নতুন কালেকশন ফাইনাল সাবমিট হয়েছে!" });
                            }
                        }
                    });
                });
            });
        });
    });
});

// 🔄 ৯. পরবর্তী দিন আপডেট 
app.post('/api/next-day-update', (req, res) => {
    const { company_id, next_date } = req.body; 
    let cid = company_id || 'COM101';

    const checkCurrentDateSql = "SELECT DATE_FORMAT(system_date, '%Y-%m-%d') as current_system_date FROM system_settings WHERE company_id = ?";
    
    db.query(checkCurrentDateSql, [cid], (checkErr, checkResults) => {
        if (checkErr || checkResults.length === 0) return res.status(500).json({ error: "সিস্টেম তারিখ যাচাই করা যায়নি।" });

        const currentSystemDate = checkResults[0].current_system_date;

        if (next_date) {
            const currentSec = new Date(currentSystemDate).getTime();
            const nextSec = new Date(next_date).getTime();
            if (nextSec <= currentSec) return res.status(400).json({ error: `ডেট ব্যাক হতে পারবে না।` });
        }

        const updateAbsentSql = `UPDATE active_loans SET accumulatedDue = accumulatedDue + targetToday WHERE isSavedToday = 'false' AND status = 'Active' AND type != 'Savings Only' AND company_id = ?`;
        db.query(updateAbsentSql, [cid], (absentErr) => {
            
            const resetSheetSql = `UPDATE active_loans SET collected = 0, savingsInput = 0, isSavedToday = 'false' WHERE company_id = ?`;
            db.query(resetSheetSql, [cid], (resetErr) => {
                
                const clearFinalSubmitSql = `DELETE FROM final_collection_submits`; 
                db.query(clearFinalSubmitSql, () => {
                    
                    let updateDateSql = '';
                    let params = [];
                    
                    if (next_date) {
                        updateDateSql = `UPDATE system_settings SET system_date = ? WHERE company_id = ?`;
                        params = [next_date, cid];
                    } else {
                        updateDateSql = `UPDATE system_settings SET system_date = DATE_ADD(system_date, INTERVAL 1 DAY) WHERE company_id = ?`;
                        params = [cid];
                    }
                    
                    db.query(updateDateSql, params, () => {
                        res.status(200).json({ message: "সফলভাবে ডে-ইন সম্পন্ন হয়েছে!" });
                    });
                });
            });
        });
    });
});

// 🛠️ ১০. ডে-এন্ড ছাড়াই এমার্জেন্সি সিস্টেম ডেট পরিবর্তনের জন্য
app.post('/api/set-system-date', (req, res) => {
    const { company_id, target_date } = req.body; 
    let cid = company_id || 'COM101';
    if(!target_date) return res.status(400).json({ error: "তারিখ প্রদান করুন!" });

    const sql = "UPDATE system_settings SET system_date = ? WHERE company_id = ?"; 
    db.query(sql, [target_date, cid], (err) => {
        if (err) return res.status(500).json({ error: "তারিখ পরিবর্তন ব্যর্থ হয়েছে।" });
        res.status(200).json({ message: `সিস্টেমের তারিখ সফলভাবে পরিবর্তন করা হয়েছে!` });
    });
});

// 🔄 ডিবি আপডেট 
app.post('/api/db-update', (req, res) => {
    db.query("ANALYZE TABLE members, active_loans", () => res.status(200).json({ message: "ডাটাবেজ আপডেট হয়েছে!" }));
});


// =========================================================================
// 📝 🎯 মডিফাইড নতুন সদস্য ভর্তি এবং পুরাতন রানিং সদস্য এন্ট্রি লজিক API
// =========================================================================
app.post('/api/member/register', (req, res) => {
    const { 
        id, name, guardianName, phone, address, 
        isOldMember, totalSavings, totalDue, disburseAmount, disburseDate, company_id 
    } = req.body;

    // ১. প্রথমে মেম্বার টেবিলে ডাটা সাধারণ নিয়মেই সেভ হবে 
    const memberSql = "INSERT INTO members (id, name, guardianName, phone, address) VALUES (?, ?, ?, ?, ?)";
    
    db.query(memberSql, [id, name, guardianName, phone, address], (err) => {
        if (err) {
            console.error("Member Insert Error:", err);
            return res.status(500).json({ error: "ডাটাবেজে সদস্য সেভ করতে ব্যর্থ!" });
        }

        // ২. ফ্লাটার থেকে যদি ইশারা আসে 'isOldMember = true', তবে একে প্রপোজাল রুমে না পাঠিয়ে ডিরেক্ট active_loans টেবিলে সচল করে দেওয়া হবে।
        if (isOldMember === true || isOldMember === 'true') {
            const finalCompanyId = company_id || 'COM101';
            
            // সরাসরি কালেকশন শিটের ফিল্টারে দেখানোর জন্য active_loans টেবিলে 'Active' এবং 'false' স্ট্যাটাসে ইনসার্ট
            const loanSql = `INSERT INTO active_loans 
                (\`id\`, \`name\`, \`disburseDate\`, \`disburseAmount\`, \`totalDue\`, \`targetToday\`, \`accumulatedDue\`, \`collected\`, \`targetWeek\`, \`totalPaid\`, \`status\`, \`type\`, \`installmentType\`, \`savingsInput\`, \`savingsTarget\`, \`totalSavings\`, \`isSavedToday\`, \`isFullPaidSection\`, \`company_id\`) 
                VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'Active', 'Regular', 'Daily', 0, 0, ?, 'false', 'false', ?)`;
            
            const loanValues = [
                id, 
                name, 
                disburseDate,     // খাতার পুরোনো ঋণের আদি তারিখ
                disburseAmount,   // খাতার পুরোনো আসল ঋণের টাকা
                totalDue,         // খাতার অবশিষ্ট বাকি ঋণ
                totalSavings,     // খাতার মোট জমানো সঞ্চয়
                finalCompanyId    // প্রতিষ্ঠান কোড
            ];

            db.query(loanSql, loanValues, (loanErr) => {
                if (loanErr) {
                    console.error("Active Loan Insert Error for Old Member:", loanErr);
                    return res.status(500).json({ error: "সদস্য প্রোফাইল তৈরি হয়েছে কিন্তু পুরাতন লোন শিটে ডিরেক্ট সচল করতে সমস্যা হয়েছে!" });
                }
                return res.status(200).json({ message: "পুরাতন রানিং সদস্য সরাসরি একটিভ লোন কালেকশন শিটে যোগ হয়েছে!" });
            });
        } else {
            // মেম্বারটি যদি সাধারণ নতুন মেম্বার হয়, তবে সে নরমালি মেম্বার হিসেবেই সেভ থাকবে (লোন প্রপোজাল রুমে শো করবে)
            return res.status(200).json({ message: "নতুন সদস্য সফলভাবে রেজিস্টার হয়েছে!" });
        }
    });
});

// 📑 লোন প্রপোজালের জন্য পেন্ডিং সদস্য তালিকা
app.get('/api/loan-proposals', (req, res) => {
    const sql = `SELECT id, name FROM members WHERE id NOT IN (SELECT id FROM active_loans) ORDER BY id ASC`;
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: "ডাটাবেজ থেকে প্রপোজাল তালিকা আনা যায়নি" });
        res.status(200).json(results);
    });
});

// 💰 লোন প্রপোজাল একটিভ করা (সদস্য একটিভ হওয়া)
app.post('/api/loan/proposal', (req, res) => {
    const {
        id, name, disburseDate, disburseAmount, totalDue, targetToday, 
        accumulatedDue, collected, targetWeek, totalPaid, status, 
        type, installmentType, savingsInput, savingsTarget, totalSavings, 
        isSavedToday, isFullPaidSection, company_id
    } = req.body;

    // 🎯 জাদুকরী লজিক: ON DUPLICATE KEY UPDATE 
    // যদি সদস্য আগে থেকেই থাকে, তবে তার আগের লোন মুছে নতুন লোনের ডাটা বসে যাবে। 
    // তবে তার আগের জমানো সঞ্চয় (totalSavings) এর সাথে নতুন সঞ্চয় যোগ হয়ে যাবে!
    const sql = `
        INSERT INTO active_loans 
        (id, name, disburseDate, disburseAmount, totalDue, targetToday, accumulatedDue, collected, targetWeek, totalPaid, status, type, installmentType, savingsInput, savingsTarget, totalSavings, isSavedToday, isFullPaidSection, company_id) 
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
        name = VALUES(name),
        disburseDate = VALUES(disburseDate),
        disburseAmount = VALUES(disburseAmount),
        totalDue = VALUES(totalDue),
        targetToday = VALUES(targetToday),
        accumulatedDue = VALUES(accumulatedDue),
        targetWeek = VALUES(targetWeek),
        status = 'Active',
        type = VALUES(type),
        installmentType = VALUES(installmentType),
        savingsTarget = VALUES(savingsTarget),
        totalSavings = COALESCE(totalSavings, 0) + VALUES(totalSavings), 
        collected = 0, 
        totalPaid = 0, 
        savingsInput = 0,
        isSavedToday = 'false'
    `;

    const values = [
        id, name, disburseDate, disburseAmount, totalDue, targetToday, accumulatedDue, 
        collected, targetWeek, totalPaid, status, type, installmentType, savingsInput, 
        savingsTarget, totalSavings, isSavedToday, isFullPaidSection, company_id
    ];

    db.query(sql, values, (err, result) => {
        if (err) {
            console.error("Loan Proposal Error:", err);
            return res.status(500).json({ error: "লোন আপডেট করতে ডাটাবেজ এরর!" });
        }
        res.status(200).json({ message: "সদস্যের লোন সফলভাবে আপডেট হয়ে কালেকশন শিটে যুক্ত হয়েছে!" });
    });
});

// 📊 ১১. ডেইলি টপ শিট 
app.get('/api/get-top-sheet-data', (req, res) => {
    let { company_id, target_date } = req.query;
    let cid = company_id || 'COM101'; 
    if (!target_date) return res.status(400).json({ error: "তারিখ প্রয়োজন!" });

    const sql = `
        SELECT 
            IFNULL(total_collection, 0) as total_kisti_collected,
            IFNULL(total_savings, 0) as total_sheet_savings,
            IFNULL(total_disbursement, 0) as total_loan_disbursed,
            IFNULL(total_disburse_savings, 0) as total_disburse_savings,
            IFNULL(total_admission_savings, 0) as total_admission_savings
        FROM daily_top_sheets 
        WHERE date = ? AND company_id = ?
    `;

    db.query(sql, [target_date, cid], (err, results) => {
        if (err) return res.status(500).json({ error: "টপ শিট এরর।" });

        if (results.length > 0) {
            const data = results[0];
            data.grand_total_savings = parseFloat(data.total_sheet_savings) + parseFloat(data.total_disburse_savings) + parseFloat(data.total_admission_savings);
            data.total_cash_in = parseFloat(data.total_kisti_collected) + data.grand_total_savings;
            res.status(200).json(data);
        } else {
            res.status(200).json({ total_kisti_collected: 0, total_sheet_savings: 0, total_loan_disbursed: 0, total_disburse_savings: 0, total_admission_savings: 0, grand_total_savings: 0, total_cash_in: 0 });
        }
    });
});

app.get('/api/get-financial-report', (req, res) => {
    const cid = req.query.company_id || '1';
    const fromDate = req.query.from_date; 
    const toDate = req.query.to_date;     

    if (!fromDate || !toDate) return res.status(400).json({ error: "তারিখ সিলেক্ট করা হয়নি!" });

    const sql = `
        SELECT 
            (SELECT IFNULL(SUM(totalSavings), 0) FROM active_loans WHERE company_id = ?) as current_savings,
            (SELECT IFNULL(SUM(totalDue), 0) FROM active_loans WHERE company_id = ?) as current_loan_balance,
            (SELECT IFNULL(SUM(accumulatedDue), 0) FROM active_loans WHERE company_id = ?) as current_due,
            (SELECT IFNULL(SUM(total_savings), 0) FROM daily_top_sheets WHERE company_id = ? AND date BETWEEN ? AND ?) as range_savings,
            (SELECT IFNULL(SUM(total_collection), 0) FROM daily_top_sheets WHERE company_id = ? AND date BETWEEN ? AND ?) as range_collection,
            (SELECT IFNULL(SUM(total_savings), 0) FROM daily_top_sheets WHERE company_id = ? AND date >= ?) as savings_from_start,
            (SELECT IFNULL(SUM(total_collection), 0) FROM daily_top_sheets WHERE company_id = ? AND date >= ?) as collection_from_start
    `;
    
    db.query(sql, [cid, cid, cid, cid, fromDate, toDate, cid, fromDate, toDate, cid, fromDate, cid, fromDate], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        
        const data = results[0];
        const opening_savings = data.current_savings - data.savings_from_start;
        const opening_loan_balance = data.current_loan_balance + data.collection_from_start;

        res.json({
            opening_savings: opening_savings >= 0 ? opening_savings : 0,
            opening_loan_balance: opening_loan_balance,
            range_savings: data.range_savings,
            range_collection: data.range_collection,
            range_loan_disbursed: 0, 
            closing_loan: data.current_loan_balance, 
            closing_savings: data.current_savings,
            closing_due: data.current_due
        });
    });
});

// ১. 🔍 মেম্বার সাজেশন API (সব সদস্যকে খুঁজবে)
app.get('/api/suggest-members', (req, res) => {
    const query = req.query.q;
    const qStr = `%${query}%`;
    
    // members এবং active_loans দুই টেবিল মিলিয়ে খুঁজবে
    const sql = `
        SELECT id, name FROM members WHERE id LIKE ? OR name LIKE ?
        UNION 
        SELECT id, name FROM active_loans WHERE id LIKE ? OR name LIKE ?
        LIMIT 15
    `;
    
    db.query(sql, [qStr, qStr, qStr, qStr], (err, results) => {
        if (err) return res.json({ success: false, message: "ডাটাবেজ এরর" });
        res.json({ success: true, members: results });
    });
});

// ==========================================================
// 🔍 ২. নির্দিষ্ট সদস্যের বিস্তারিত ডাটা আনার API
// ==========================================================
app.get('/api/get-member/:id', (req, res) => {
    const memberId = req.params.id;
    
    // প্রথমে কালেকশন শিটে খুঁজবে (কারণ সঞ্চয়ী সদস্যরা এখানেই থাকে)
    const sql1 = `SELECT id, name, '' as phone, '' as father_name FROM active_loans WHERE id = ?`;
    
    db.query(sql1, [memberId], (err, results1) => {
        if (results1 && results1.length > 0) {
            // যদি কালেকশন শিটে পায়, তবে তার মোবাইল নাম্বার আনার জন্য members টেবিলে উঁকি দিবে
            const sql2 = `SELECT phone, guardianName as father_name FROM members WHERE id = ?`;
            db.query(sql2, [memberId], (err2, results2) => {
                let memberData = results1[0];
                if (results2 && results2.length > 0) {
                    memberData.phone = results2[0].phone;
                    memberData.father_name = results2[0].father_name;
                }
                return res.json({ success: true, member: memberData });
            });
        } else {
            // যদি কালেকশন শিটে না থাকে, তবে সরাসরি members টেবিল থেকে আনবে
            const sql3 = `SELECT id, name, phone, guardianName as father_name FROM members WHERE id = ?`;
            db.query(sql3, [memberId], (err3, results3) => {
                if (results3 && results3.length > 0) {
                    return res.json({ success: true, member: results3[0] });
                }
                res.json({ success: false, message: "সদস্য পাওয়া যায়নি!" });
            });
        }
    });
});
// ৩. 🗑️ ডিলিট API (কালেকশন শিট এবং মেম্বার লিস্ট দুই জায়গা থেকেই মুছবে)
app.post('/api/delete-member', (req, res) => {
    const { id } = req.body;

    // প্রথমে active_loans (কালেকশন শিট) থেকে মুছবে
    const deleteFromLoans = "DELETE FROM active_loans WHERE id = ?";
    db.query(deleteFromLoans, [id], (err1) => {
        if (err1) {
            return res.json({ success: false, message: "কালেকশন শিট থেকে মুছতে সমস্যা হয়েছে!" });
        }

        // এরপর members টেবিল থেকেও মুছে দেবে
        const deleteFromMembers = "DELETE FROM members WHERE id = ?";
        db.query(deleteFromMembers, [id], (err2) => {
            if (err2) {
                return res.json({ success: false, message: "সদস্য তালিকা থেকে মুছতে সমস্যা হয়েছে!" });
            }
            res.json({ success: true, message: "সদস্যকে কালেকশন শিট ও সিস্টেম থেকে চিরতরে ডিলিট করা হয়েছে!" });
        });
    });
});

// 📊 ম্যানেজার লাইভ অ্যানালিটিক্স রিপোর্ট API
app.get('/api/manager-live-analytics', (req, res) => {
    const loanSummarySql = `
        SELECT 
            IFNULL(SUM(CASE WHEN loan_type = 'Daily' THEN totalDue ELSE 0 END), 0) as dailyLoan,
            IFNULL(SUM(CASE WHEN loan_type = 'Weekly' THEN totalDue ELSE 0 END), 0) as weeklyLoan,
            IFNULL(SUM(CASE WHEN loan_type = 'Consumer' THEN totalDue ELSE 0 END), 0) as consumerLoan,
            IFNULL(SUM(totalDue), 0) as totalLoanBalance
        FROM active_loans;
    `;
    db.query(loanSummarySql, (err, results) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true, data: { loanSummary: results[0] } });
    });
});

const PORT = 3000;
app.listen(PORT, () => console.log(`মাল্টি-সমিতি ব্যাকএন্ড সার্ভার চালু হয়েছে পোর্ট: ${PORT}`));