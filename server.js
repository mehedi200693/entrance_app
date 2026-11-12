console.log("মাল্টি-সমিতি ব্যাকএন্ড সার্ভার চালু হচ্ছে...");
const express = require('express');
const mysql = require('mysql2/promise');
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
    database: 'defaultdb',
    waitForConnections: true,
    connectionLimit: 10,
    queueLimit: 0,
    ssl: {
        rejectUnauthorized: false
    }
});

db.getConnection()
  .then(connection => {
    console.log("ডাটাবেজের সাথে সফলভাবে কানেক্ট হয়েছে");
    connection.release();
  })
  .catch(err => {
    console.log("ডাটাবেজ কানেকশনে সমস্যা:", err);
  });

// 💡 ফিক্স ১: টার্গেট অ্যামাউন্ট ০ না দেখিয়ে আসল টার্গেট দেখানোর লজিক
const sanitizeData = (results) => {
    return results.map(row => ({
        ...row,
        collected: (row.collected == null || row.collected == 0) ? (row.targetToday ?? 0) : row.collected,
        savingsInput: (row.savingsInput == null || row.savingsInput == 0) ? (row.savingsTarget ?? 0) : row.savingsInput,
        targetToday: row.targetToday ?? 0,
        savingsTarget: row.savingsTarget ?? 0,
        totalSavings: row.totalSavings ?? 0,
        totalDue: row.totalDue ?? 0,
        accumulatedDue: row.accumulatedDue ?? 0
    }));
};

app.post('/api/login', async (req, res) => {
    const { username, password } = req.body;
    const sql = "SELECT company_id, username, name, role FROM users WHERE username = ? AND password = ? AND status = 'Active'";
    try {
        const [results] = await db.query(sql, [username, password]);
        if (results.length === 0) return res.status(401).json({ error: "ইউজার আইডি বা পাসওয়ার্ড ভুল!" });
        res.status(200).json({ message: "সফল লগইন", user: results[0] });
    } catch (err) {
        console.log("Login Database Error: ", err);
            return res.status(500).json({ error: "সার্ভার এরর: " + err.message });
        }
});

// 🔢 নতুন সদস্যের সিরিয়াল আইডি তৈরি করার API
app.get('/api/get-next-member-id', (req, res) => {
    const sql = "SELECT id FROM members ORDER BY CAST(id AS UNSIGNED) DESC LIMIT 1";
    db.query(sql, (err, results) => {
        if (err) return res.status(500).json({ error: "ডাটাবেজ এরর" });
        let nextId = 1001;
        if (results.length > 0 && !isNaN(results[0].id)) {
            nextId = parseInt(results[0].id) + 1;
        }
        res.status(200).json({ next_id: nextId.toString() });
    });
});

// 📅 ২. সিস্টেম তারিখ জানার API 
app.get('/api/get-system-date', async (req, res) => {
    let companyId = req.query.company_id || 'COM101';
    const sql = "SELECT DATE_FORMAT(system_date, '%Y-%m-%d') as s_date FROM system_settings WHERE company_id = ?";
    try {
        const [results] = await db.query(sql, [companyId]);
        if (results.length === 0) {
            const fallbackDate = new Date().toISOString().split('T')[0];
            return res.status(200).json({ current_date: fallbackDate, system_date: fallbackDate, date: fallbackDate });
        }
        const dbDate = results[0].s_date;
        res.status(200).json({ current_date: dbDate, system_date: dbDate, date: dbDate });
    } catch (err) {
        console.log("Get System Date Database Error: ", err);
        return res.status(500).json({ error: "সার্ভার এরর: " + err.message });
    }
});

// 📥 ৩. কালেকশন শিট ডাটা API
app.get('/api/get-collection-data', async (req, res) => {
    const sql = "SELECT * FROM active_loans WHERE status = 'Active' AND isSavedToday = 'false'";
    try {
        const [results] = await db.query(sql);
        
       return res.status(200).json(sanitizeData(results));
    } catch (err) {
        console.log("Get Collection Data Database Error: ", err);
        return res.status(500).json({ error: "ডাটা আনতে সমস্যা হয়েছে:" + err.message });
    }
});

// 3.1 ফিন্যান্সিয়াল রিপোর্ট প্রিন্ট HTML
app.get('/api/print-financial-report', async (req, res) => {
    const company_id = req.query.company_id;
    const from_date = req.query.from_date;
    const to_date = req.query.to_date;

    db.query(`SELECT COUNT(id) as total_members, SUM(totalSavings) as total_savings, SUM(totalDue) as total_due FROM active_loans WHERE company_id = ?`, [company_id], (err, closingRows) => {
        if (err) return res.status(500).send("Database Error (closing): " + err.message);

        db.query(`SELECT SUM(total_collection) as sum_recovery, SUM(total_savings) as sum_savings, SUM(total_withdraw) as sum_withdraw FROM daily_top_sheets WHERE company_id = ? AND date BETWEEN ? AND ?`, [company_id, from_date, to_date], (err, dailyRows) => {
            if (err) return res.status(500).send("Database Error (daily): " + err.message);

            db.query(`SELECT SUM(disburseAmount) as sum_new_loans FROM active_loans WHERE company_id = ? AND disburseDate BETWEEN ? AND ?`, [company_id, from_date, to_date], (err, loanRows) => {
                if (err) return res.status(500).send("Database Error (disbursement): " + err.message);

                const dbClosing = closingRows && closingRows[0] ? closingRows[0] : {};
                const dbDaily = dailyRows && dailyRows[0] ? dailyRows[0] : {};
                const dbLoan = loanRows && loanRows[0] ? loanRows[0] : {};

                const loan_disbursed_principal = Number(dbLoan.sum_new_loans) || 0; 
                const loan_disbursed_with_profit = loan_disbursed_principal > 0 ? loan_disbursed_principal * 1.20 : 0; 
                const loan_recovery = Number(dbDaily.sum_recovery) || 0; 
                const net_loan_change = loan_disbursed_with_profit - loan_recovery;

                const regular_savings = Number(dbDaily.sum_savings) || 0;
                const disburse_savings_deduction = loan_disbursed_principal * 0.10; 
                const total_savings_collection = regular_savings + disburse_savings_deduction; 
                
                const savings_refund = Number(dbDaily.sum_withdraw) || 0;
                const net_savings_change = total_savings_collection - savings_refund;

                const closing_members = dbClosing.total_members || 0;
                const closing_savings = dbClosing.total_savings || 0;
                const closing_loan = dbClosing.total_due || 0;

                const opening_members = closing_members; 
                const opening_savings = closing_savings - net_savings_change;
                const opening_loan = closing_loan - net_loan_change;

                const data = {
                    company_name: "Entrance Multipurpose Co-operative Society Ltd.",
                    branch: "Branch: 01 (Banasree Branch)",
                    address: "South Banasree, Khilgaon, Dhaka-1219",
                    date_range: `Date: ${from_date} to ${to_date}`,
                    opening: { members: opening_members, savings_os: Math.round(opening_savings), loan_due: Math.round(opening_loan), loan_os: Math.round(opening_loan) },
                    during: { new_members: 0, dropouts: 0, savings_col: Math.round(total_savings_collection), savings_ref: Math.round(savings_refund), disbursed_qty: loan_disbursed_principal > 0 ? 1 : 0, disbursed_amt: Math.round(loan_disbursed_principal), recovery: Math.round(loan_recovery) },
                    closing: { members: closing_members, savings_os: Math.round(closing_savings), loan_due: Math.round(closing_loan), loan_os: Math.round(closing_loan) }
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
app.post('/api/next-day-update', async (req, res) => {
  try {
    let { company_id, next_date } = req.body;
    let cid = company_id || '101';

    const checkCurrentDateSql = "SELECT DATE_FORMAT(system_date, '%Y-%m-%d') as current_system_date FROM system_settings WHERE company_id = ?";
    const [checkResults] = await db.query(checkCurrentDateSql, [cid]);

    if (checkResults.length === 0) return res.status(404).json({ error: 'সিস্টেম তারিখ পাওয়া যায়নি' });

    const currentSystemDate = checkResults[0].current_system_date;
    if (next_date) {
      const currentSec = new Date(currentSystemDate).getTime();
      const nextSec = new Date(next_date).getTime();
      if (nextSec <= currentSec) return res.status(400).json({ error: 'ডেট আগের তারিখের হতে পারবে না' });
    }

    const updateAbsentSql = "UPDATE active_loans SET accumulatedDue = accumulatedDue + targetToday WHERE isSavedToday = 'false' AND status = 'Active' AND company_id = ?";
    await db.query(updateAbsentSql, [cid]);

    const resetSheetSql = "UPDATE active_loans SET collected = 0, savingsInput = 0, isSavedToday = 'false' WHERE company_id = ?";
    await db.query(resetSheetSql, [cid]);

    const clearFinalSubmitSql = "DELETE FROM final_collection_submits";
    await db.query(clearFinalSubmitSql);

    let updateDateSql = '';
    let params = [];
    if (next_date) {
      updateDateSql = "UPDATE system_settings SET system_date = ? WHERE company_id = ?";
      params = [next_date, cid];
    } else {
      updateDateSql = "UPDATE system_settings SET system_date = DATE_ADD(system_date, INTERVAL 1 DAY) WHERE company_id = ?";
      params = [cid];
    }

    await db.query(updateDateSql, params);
    return res.status(200).json({ message: 'সফলভাবে ডে-এন্ড সম্পন্ন হয়েছে' });

  } catch (err) {
    console.log("next-day-update error:", err);
    return res.status(500).json({ error: 'তারিখ আপডেটে ব্যর্থ' });
  }
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

// 📝 নতুন সদস্য ভর্তি এবং পুরাতন রানিং সদস্য এন্ট্রি লজিক API
app.post('/api/member/register', async (req, res) => {
    const { id, name, guardianName, phone, address, isOldMember, totalSavings, totalDue, disburseAmount, disburseDate, company_id, branch_code, samity_code, samity_name, officer_code, officer_name, field_officer } = req.body;
    
    const finalOfficer = field_officer || officer_name || '';
    
    try {
      await db.query("INSERT INTO members (id, name, guardianName, phone, address, branch_code, samity_code, field_officer) VALUES (?, ?, ?, ?, ?, ?, ?, ?)",
        [id, name, guardianName, phone, address, branch_code || null, samity_code || null, finalOfficer]);

      if (isOldMember === true || isOldMember === 'true') {
        const finalCompanyId = company_id || 'COM101';
        await db.query(`INSERT INTO active_loans (\`id\`, \`name\`, \`disburseDate\`, \`disburseAmount\`, \`totalDue\`, \`targetToday\`, \`accumulatedDue\`, \`collected\`, \`targetWeek\`, \`totalPaid\`, \`status\`, \`type\`, \`installmentType\`, \`savingsInput\`, \`savingsTarget\`, \`totalSavings\`, \`isSavedToday\`, \`isFullPaidSection\`, \`company_id\`, \`branch_code\`, \`samity_code\`, \`samity_name\`, \`officer_code\`) VALUES (?, ?, ?, ?, ?, 0, 0, 0, 0, 0, 'Active', 'Regular', 'Daily', 0, 0, ?, 'false', 'false', ?, ?, ?, ?, ?)`,
          [id, name, disburseDate, disburseAmount, totalDue, totalSavings, finalCompanyId, branch_code || null, samity_code || null, samity_name || null, officer_code || null]);
      }
      res.status(200).json({ message: "সদস্য সফলভাবে রেজিস্টার হয়েছে!" });
    } catch (err) {
      res.status(500).json({ error: "ডাটাবেজে সদস্য সেভ করতে ব্যর্থ! " + err.message });
    }
});

// 📑 লোন প্রপোজালের জন্য পেন্ডিং সদস্য তালিকা
// লোন প্রপোজালের জন্য পেন্ডিং সদস্য তালিকা
app.get('/api/loan-proposals', async (req, res) => {
  const companyId = req.query.company_id || 'COM101';
  const currentDate = req.query.current_date; // Flutter থেকে আসা 2026-11-07, এটাই অ্যাপসের সিস্টেম ডেট
  const strictToday = req.query.strict_today === 'true';

  let sql = "SELECT id, name, admission_date, created_at, date FROM members WHERE id NOT IN (SELECT id FROM active_loans)";
  let params = [];

  // কোম্পানি ফিল্টার - members টেবিলে company_id কলাম থাকলে
  // যদি members এ company_id না থাকে তাহলে নিচের ২ লাইন কেটে দিবেন
  // sql += " AND company_id = ?";
  // params.push(companyId);

  // শুধুমাত্র অ্যাপসের আজকের তারিখের (সিস্টেম ডেট) সদস্য
  if (strictToday && currentDate) {
    sql += " AND (DATE(admission_date) = ? OR DATE(created_at) = ? OR DATE(date) = ?)";
    params.push(currentDate, currentDate, currentDate);
  }

  sql += " ORDER BY id ASC";

  try {
    const [results] = await db.query(sql, params);
    return res.status(200).json(results);
  } catch (err) {
    return res.status(500).json({ error: "ডাটাবেজ থেকে প্রপোজাল তালিকা আনা যায়নি: " + err.message });
  }
});

// 💰 লোন প্রপোজাল একটিভ করা 
// লোন প্রপোজাল একাউন্ট করা
app.post('/api/loan/proposal', async (req, res) => {
  const { id, name, disburseDate, disburseAmount, totalDue, targetToday, accumulatedDue, collected, targetWeek, totalPaid, status, type, installmentType } = req.body;
  const sql = "INSERT INTO active_loans (id, name, disburseDate, disburseAmount, totalDue, targetToday, accumulatedDue, collected, targetWeek, totalPaid, status, type, installmentType) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)";

  try {
    await db.query(sql, [id, name, disburseDate, disburseAmount, totalDue, targetToday, accumulatedDue, collected, targetWeek, totalPaid, status, type, installmentType]);
    return res.status(200).json({ message: "সদস্যের লোন সফলভাবে আপডেট হয়ে কালেকশন শিটে যুক্ত হয়েছে!" });
  } catch (err) {
    return res.status(500).json({ error: "লোন আপডেট করতে ডাটাবেজ এরর: " + err.message });
  }
});

// 📊 ১১. ডেইলি টপ শিট 
app.get('/api/get-top-sheet-data', (req, res) => {
    let { company_id, target_date } = req.query;
    let cid = company_id || 'COM101'; 
    if (!target_date) return res.status(400).json({ error: "তারিখ প্রয়োজন!" });

    const sql = `SELECT IFNULL(total_collection, 0) as total_kisti_collected, IFNULL(total_savings, 0) as total_sheet_savings, IFNULL(total_disbursement, 0) as total_loan_disbursed, IFNULL(total_disburse_savings, 0) as total_disburse_savings, IFNULL(total_admission_savings, 0) as total_admission_savings FROM daily_top_sheets WHERE date = ? AND company_id = ?`;
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

    const sql = `SELECT (SELECT IFNULL(SUM(totalSavings), 0) FROM active_loans WHERE company_id = ?) as current_savings, (SELECT IFNULL(SUM(totalDue), 0) FROM active_loans WHERE company_id = ?) as current_loan_balance, (SELECT IFNULL(SUM(accumulatedDue), 0) FROM active_loans WHERE company_id = ?) as current_due, (SELECT IFNULL(SUM(total_savings), 0) FROM daily_top_sheets WHERE company_id = ? AND date BETWEEN ? AND ?) as range_savings, (SELECT IFNULL(SUM(total_collection), 0) FROM daily_top_sheets WHERE company_id = ? AND date BETWEEN ? AND ?) as range_collection, (SELECT IFNULL(SUM(total_savings), 0) FROM daily_top_sheets WHERE company_id = ? AND date >= ?) as savings_from_start, (SELECT IFNULL(SUM(total_collection), 0) FROM daily_top_sheets WHERE company_id = ? AND date >= ?) as collection_from_start`;
    db.query(sql, [cid, cid, cid, cid, fromDate, toDate, cid, fromDate, toDate, cid, fromDate, cid, fromDate], (err, results) => {
        if (err) return res.status(500).json({ error: err.message });
        const data = results[0];
        const opening_savings = data.current_savings - data.savings_from_start;
        const opening_loan_balance = data.current_loan_balance + data.collection_from_start;
        res.json({ opening_savings: opening_savings >= 0 ? opening_savings : 0, opening_loan_balance: opening_loan_balance, range_savings: data.range_savings, range_collection: data.range_collection, range_loan_disbursed: 0, closing_loan: data.current_loan_balance, closing_savings: data.current_savings, closing_due: data.current_due });
    });
});

// ১. 🔍 মেম্বার সাজেশন API
app.get('/api/suggest-members', (req, res) => {
    const query = req.query.q;
    const qStr = `%${query}%`;
    const sql = `SELECT id, name FROM members WHERE id LIKE ? OR name LIKE ? UNION SELECT id, name FROM active_loans WHERE id LIKE ? OR name LIKE ? LIMIT 15`;
    db.query(sql, [qStr, qStr, qStr, qStr], (err, results) => {
        if (err) return res.json({ success: false, message: "ডাটাবেজ এরর" });
        res.json({ success: true, members: results });
    });
});

// 🔍 ২. নির্দিষ্ট সদস্যের বিস্তারিত ডাটা আনার API
app.get('/api/get-member/:id', (req, res) => {
    const memberId = req.params.id;
    const sql1 = `SELECT id, name, '' as phone, '' as father_name FROM active_loans WHERE id = ?`;
    db.query(sql1, [memberId], (err, results1) => {
        if (results1 && results1.length > 0) {
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
            const sql3 = `SELECT id, name, phone, guardianName as father_name FROM members WHERE id = ?`;
            db.query(sql3, [memberId], (err3, results3) => {
                if (results3 && results3.length > 0) return res.json({ success: true, member: results3[0] });
                res.json({ success: false, message: "সদস্য পাওয়া যায়নি!" });
            });
        }
    });
});

// ৩. 🗑️ ডিলিট API
app.post('/api/delete-member', (req, res) => {
    const { id } = req.body;
    const deleteFromLoans = "DELETE FROM active_loans WHERE id = ?";
    db.query(deleteFromLoans, [id], (err1) => {
        if (err1) return res.json({ success: false, message: "কালেকশন শিট থেকে মুছতে সমস্যা হয়েছে!" });
        const deleteFromMembers = "DELETE FROM members WHERE id = ?";
        db.query(deleteFromMembers, [id], (err2) => {
            if (err2) return res.json({ success: false, message: "সদস্য তালিকা থেকে মুছতে সমস্যা হয়েছে!" });
            res.json({ success: true, message: "সদস্যকে চিরতরে ডিলিট করা হয়েছে!" });
        });
    });
});

// 📊 ম্যানেজার লাইভ অ্যানালিটিক্স রিপোর্ট API
app.get('/api/manager-live-analytics', (req, res) => {
    const loanSummarySql = `SELECT IFNULL(SUM(CASE WHEN loan_type = 'Daily' THEN totalDue ELSE 0 END), 0) as dailyLoan, IFNULL(SUM(CASE WHEN loan_type = 'Weekly' THEN totalDue ELSE 0 END), 0) as weeklyLoan, IFNULL(SUM(CASE WHEN loan_type = 'Consumer' THEN totalDue ELSE 0 END), 0) as consumerLoan, IFNULL(SUM(totalDue), 0) as totalLoanBalance FROM active_loans;`;
    db.query(loanSummarySql, (err, results) => {
        if (err) return res.status(500).json({ success: false });
        res.json({ success: true, data: { loanSummary: results[0] } });
    });
});

// =========================================================================
// 🔀 ফিক্সড ও আপডেটেড: দৈনিক ক্যাশ বুক সামারি ও মেম্বারভিত্তিক ট্রানজেকশন হিস্টোরি
// =========================================================================
app.get('/api/get-daily-cash-summary', (req, res) => {
    const { company_id, date } = req.query;
    const sqlOpening = `SELECT closing_balance FROM daily_cash_closings WHERE company_id = ? AND date < ? ORDER BY date DESC LIMIT 1`;
    const sqlCollections = `
        SELECT al.name as member_name, lh.collected as installment_collected, lh.savings as savings_collected 
        FROM loan_history lh
        JOIN active_loans al ON lh.member_id = al.id
        WHERE lh.date = ? AND al.company_id = ? AND lh.type = 'নিয়মিত আদায়'
    `;
    const sqlDisbursements = `SELECT name, disburseAmount FROM active_loans WHERE company_id = ? AND disburseDate = ?`;
    const sqlWithdrawals = `
        SELECT lh.member_id, al.name as member_name, lh.gs_w 
        FROM loan_history lh
        JOIN active_loans al ON lh.member_id = al.id
        WHERE al.company_id = ? AND lh.date = ? AND lh.type = 'সঞ্চয় উত্তোলন'
    `;
    const sqlOfficeTx = `SELECT transaction_type, category, amount FROM office_transactions WHERE company_id = ? AND date = ?`;

    db.query(sqlOpening, [company_id, date], (err, openingRes) => {
        let openingBalance = (openingRes && openingRes.length > 0) ? parseFloat(openingRes[0].closing_balance) : 0.0;

        db.query(sqlCollections, [date, company_id], (err, collRes) => {
            let incomeDetails = [];
            let fieldCollectionTotal = 0.0;

            if (collRes && !err) {
                collRes.forEach(row => {
                    let kisti = parseFloat(row.installment_collected || 0);
                    let sanchay = parseFloat(row.savings_collected || 0);
                    let total = kisti + sanchay;
                    if (total > 0) {
                        fieldCollectionTotal += total;
                        incomeDetails.push({ category: `মাঠ আদায়: ${row.member_name || 'সদস্য'}`, amount: total });
                    }
                });
            }

            db.query(sqlDisbursements, [company_id, date], (err, disbRes) => {
                let expenseDetails = [];
                let loanDisbursementTotal = 0.0;

                if (disbRes && !err) {
                    disbRes.forEach(row => {
                        let amt = parseFloat(row.disburseAmount || 0);
                        if (amt > 0) {
                            loanDisbursementTotal += amt;
                            expenseDetails.push({ category: `ঋণ বিতরণ: ${row.name || 'সদস্য'}`, amount: amt });
                        }
                    });
                }

                db.query(sqlWithdrawals, [company_id, date], (err, withRes) => {
                     let withdrawalTotal = 0.0;
                     if (withRes && !err) {
                         withRes.forEach(row => {
                             let amt = parseFloat(row.gs_w || 0);
                             if (amt > 0) {
                                 withdrawalTotal += amt;
                                 expenseDetails.push({ category: `সঞ্চয় উত্তোলন: ${row.member_name || row.member_id}`, amount: amt });
                             }
                         });
                     }

                    db.query(sqlOfficeTx, [company_id, date], (err, officeTxRes) => {
                        let officeIncomeTotal = 0.0;
                        let officeExpenseTotal = 0.0;

                        if (officeTxRes && !err) {
                            officeTxRes.forEach(tx => {
                                let amt = parseFloat(tx.amount || 0);
                                if (tx.transaction_type === 'Income') {
                                    officeIncomeTotal += amt;
                                    incomeDetails.push({ category: `অফিস আয়: ${tx.category}`, amount: amt });
                                } else {
                                    officeExpenseTotal += amt;
                                    expenseDetails.push({ category: `অফিস ব্যয়: ${tx.category}`, amount: amt });
                                }
                            });
                        }

                        let totalIncome = fieldCollectionTotal + officeIncomeTotal;
                        let totalExpense = loanDisbursementTotal + withdrawalTotal + officeExpenseTotal;
                        let closingBalance = (openingBalance + totalIncome) - totalExpense;

                        res.status(200).json({
                            opening_balance: openingBalance,
                            total_income: totalIncome,
                            total_expense: totalExpense,
                            closing_balance: closingBalance,
                            income_details: incomeDetails,
                            expense_details: expenseDetails
                        });
                    });
                });
            });
        });
    });
});

app.post('/api/add-office-transaction', (req, res) => {
    const { company_id, date, transaction_type, category, amount, description } = req.body;
    if(!category || !amount) return res.status(400).json({ error: "খাত এবং টাকার পরিমাণ আবশ্যক!" });
    const sql = `INSERT INTO office_transactions (company_id, date, transaction_type, category, amount, description) VALUES (?, ?, ?, ?, ?, ?)`;
    db.query(sql, [company_id || 'COM101', date, transaction_type, category, amount, description || ''], (err, result) => {
        if (err) {
            console.error("Voucher Save Error:", err);
            return res.status(500).json({ error: "অফিস ট্রানজেকশন সেভ করতে ডাটাবেজে সমস্যা হয়েছে।" });
        }
        res.status(200).json({ message: "✅ ভাউচার সফলভাবে সেভ হয়েছে!" });
    });
});

app.post('/api/close-day-cash', (req, res) => {
    const { company_id, date, opening_balance, total_income, total_expense, closing_balance } = req.body;
    const sql = `
        INSERT INTO daily_cash_closings (company_id, date, opening_balance, total_income, total_expense, closing_balance) 
        VALUES (?, ?, ?, ?, ?, ?)
        ON DUPLICATE KEY UPDATE 
        opening_balance = VALUES(opening_balance),
        total_income = VALUES(total_income),
        total_expense = VALUES(total_expense),
        closing_balance = VALUES(closing_balance)
    `;
    db.query(sql, [company_id || 'COM101', date, opening_balance, total_income, total_expense, closing_balance], (err, result) => {
        if (err) {
            console.error("Day Close Error:", err);
            return res.status(500).json({ error: "আজকের ডে-ক্লোজ ডাটাবেজে সেভ করতে সমস্যা হয়েছে।" });
        }
        res.status(200).json({ message: "🔒 আজকের দিনের ক্যাশবুক সফলভাবে লক করা হয়েছে!" });
    });
});

app.post('/api/hierarchy-details', (req, res) => {
    let { hierarchy, name, code, establishmentDate, operationDate, activityStatus, correctionDayAllotment, address, contactInformation } = req.body;
    establishmentDate = establishmentDate.split('-').reverse().join('-');
    operationDate = operationDate.split('-').reverse().join('-');
    const sqlQuery = "INSERT INTO hierarchy_details (hierarchy, name, code, establishment_date, operation_date, activity_status, correction_day_allotment, address, contact_information) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?)";
    db.query(sqlQuery, [hierarchy, name, code, establishmentDate, operationDate, activityStatus, correctionDayAllotment, address, contactInformation], (err, result) => {
        if (err) return res.status(500).json({ error: "ডাটা সেভ করতে সমস্যা হয়েছে!" });
        res.status(200).json({ message: "সফলভাবে সেভ হয়েছে!" });
    });
});

app.get('/api/hierarchy-details', (req, res) => {
    db.query("SELECT * FROM hierarchy_details", (err, results) => {
        if (err) return res.status(500).json({ error: "ডাটা লোড করতে সমস্যা!" });
        res.status(200).json(results);
    });
});

app.post('/api/hierarchy-manager', (req, res) => {
    let { hierarchyLevel, hierarchyDetails, hName, code, establishmentDate, managerName } = req.body;
    establishmentDate = establishmentDate.split('-').reverse().join('-');
    const sqlQuery = "INSERT INTO hierarchy_managers (hierarchy_level, hierarchy_details, h_name, code, establishment_date, manager_name) VALUES (?, ?, ?, ?, ?, ?)";
    db.query(sqlQuery, [hierarchyLevel, hierarchyDetails, hName, code, establishmentDate, managerName], (err, result) => {
        if (err) return res.status(500).json({ error: "ম্যানেজার ট্যাগ করতে সমস্যা!" });
        res.status(200).json({ message: "ম্যানেজার সফলভাবে যুক্ত হয়েছে!" });
    });
});

app.get('/api/hierarchy-manager', (req, res) => {
    db.query("SELECT * FROM hierarchy_managers", (err, results) => {
        if (err) return res.status(500).json({ error: "ম্যানেজার লোড করতে সমস্যা!" });
        res.status(200).json(results);
    });
});

app.post('/api/hierarchy-management', (req, res) => {
    const { parentLevel, parentDetails, childListId } = req.body;
    const sqlQuery = "INSERT INTO hierarchy_management (parent_level, parent_details, child_list_id) VALUES (?, ?, ?)";
    db.query(sqlQuery, [parentLevel, parentDetails, childListId], (err, result) => {
        if (err) return res.status(500).json({ error: "ম্যানেজমেন্ট সেভ করতে সমস্যা!" });
        res.status(200).json({ message: "সফলভাবে সেভ হয়েছে!" });
    });
});

app.get('/api/hierarchy-management', (req, res) => {
    db.query("SELECT * FROM hierarchy_management", (err, results) => {
        if (err) return res.status(500).json({ error: "ডাটা লোড করতে সমস্যা!" });
        res.status(200).json(results);
    });
});

// =========================================================================
// 🆕 ফিক্সড: কালেকশন শিট সার্চ - এখন আর হার্ডকোড ২ জন না, MySQL থেকে আসবে
// =========================================================================
app.get('/api/members/search', (req, res) => {
  const searchQuery = req.query.q;
  if (!searchQuery) return res.json([]);

  const qLike = `%${searchQuery}%`;
  // আপনার active_loans এবং members দুই জায়গা থেকেই খুঁজবে
  const sql = `
    SELECT al.id as memberId, al.id as softwareId, al.name as memberName, m.guardianName, m.phone
    FROM active_loans al
    LEFT JOIN members m ON al.id = m.id
    WHERE al.id LIKE ? OR al.name LIKE ?
    UNION
    SELECT m.id as memberId, m.id as softwareId, m.name as memberName, m.guardianName, m.phone
    FROM members m
    WHERE m.id LIKE ? OR m.name LIKE ?
    LIMIT 20
  `;
  db.query(sql, [qLike, qLike, qLike, qLike], (err, results) => {
    if (err) {
        console.log(err);
        return res.status(500).json({ error: "সার্চ এরর" });
    }
    // Flutter যাতে আগের মতোই পায়, সেজন্য sl যোগ করে দিলাম
    const mapped = results.map((r, i) => ({
        sl: (i+1).toString(),
        softwareId: r.memberId,
        memberId: r.memberId,
        memberName: r.memberName,
        guardianName: r.guardianName || '',
        phone: r.phone || '',
        fieldOfficer: 'Md. Mehdi Hasan',
        status: 'Active'
    }));
    res.json(mapped);
  });
});

// =========================================================================
// 🆕 নতুন যুক্ত: আপনার ছবির মতো Collection Sheet এর জন্য আসল API
// এই API আপনার ৪টা ছবির সব ঘর (Loan Balance, PA, SC, Due) অটো হিসাব করে দিবে
// =========================================================================
app.get('/api/collection-sheet-full', (req, res) => {
    const company_id = req.query.company_id || 'COM101';
    const officer_code = (req.query.officer_code || '').toString();
    const officer_name = (req.query.officer_name || req.query.officer || '').toString();
    const samity_code = (req.query.samity_code || req.query.samity || '').toString().split(' ')[0];

    let sql = `
        SELECT 
            al.id, al.name, al.disburseDate, al.disburseAmount,
            al.totalDue, al.targetToday, al.accumulatedDue,
            al.totalSavings, al.collected, al.savingsInput,
            al.officer_code, al.samity_code, al.samity_name,
            m.guardianName, m.phone, m.address,
            m.branch_code, m.samity_code AS m_samity_code, m.field_officer
        FROM active_loans al
        LEFT JOIN members m ON al.id = m.id
        WHERE al.status = 'Active' AND al.company_id = ?
    `;
    let params = [company_id];

    // Officer ফিল্টার - এখন active_loans.officer_code দিয়েই হবে, নাম খোঁজা লাগবে না
    if (officer_code) {
        sql += ` AND (al.officer_code = ? OR m.field_officer = ?)`;
        params.push(officer_code, officer_name);
    }

    // Samity ফিল্টার - দুই টেবিলেই চেক করবে, যেটাতে থাকে সেটাতেই মিলবে
    if (samity_code) {
        sql += ` AND (al.samity_code = ? OR m.samity_code = ?)`;
        params.push(samity_code, samity_code);
    }

    sql += ` ORDER BY CAST(al.id AS UNSIGNED) ASC`;

    db.query(sql, params, (err, results) => {
        if (err) return res.status(500).json({ error: "Collection Sheet আনতে সমস্যা: " + err.message });

        const enriched = results.map(row => {
            const totalDue = parseFloat(row.totalDue) || 0;
            const pa_ratio = 0.8333;
            const pa_balance = Math.round(totalDue * pa_ratio);
            const sc_balance = Math.round(totalDue - pa_balance);
            const targetToday = parseFloat(row.targetToday) || 0;
            const collected = parseFloat(row.collected) || 0;
            const new_due = targetToday > collected ? targetToday - collected : 0;
            return {
                ...row,
                pa_balance: pa_balance,
                sc_balance: sc_balance,
                total_balance: totalDue,
                loan_collection_pa: Math.round(collected * pa_ratio),
                loan_collection_sc: Math.round(collected * (1-pa_ratio)),
                new_due: new_due,
                closing_due: parseFloat(row.accumulatedDue) || 0,
                loan_pa: pa_balance,
                loan_sc: sc_balance
            };
        });
        res.status(200).json(enriched);
    });
});
// সব ব্রাঞ্চ দেখা
app.get('/api/branches', async (req, res) => {
  try {
    const [rows] = await db.query('SELECT * FROM branches ORDER BY id DESC');
    res.json(rows);
  } catch (err) {
    res.status(500).json({ message: 'Error loading branches' });
  }
});

// নতুন ব্রাঞ্চ সেভ করা
app.post('/api/branches', async (req, res) => {
  try {
    const { branch_code, branch_name, address, mobile, manager_name } = req.body;

    if (!branch_code || !branch_name) {
      return res.status(400).json({ message: 'Branch Code আর Branch Name লাগবেই' });
    }

    await db.query(
      'INSERT INTO branches (branch_code, branch_name, address, mobile, manager_name) VALUES (?,?,?,?,?)',
      [branch_code, branch_name, address, mobile, manager_name]
    );
    res.json({ message: 'Branch Saved' });
  } catch (err) {
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'এই Branch Code আগেই আছে' });
    }
    res.status(500).json({ message: 'Save failed' });
  }
});
// GET Samity List
// GET Samity List - Branch + Officer + Day + Type দিয়ে ফিল্টার
app.get('/api/samity', async (req, res) => {
  try {
    const { branch_code, branch, officer_code, day, meeting_day, type, samity_type } = req.query;

    let sql = "SELECT * FROM samity_setup WHERE 1=1";
    let params = [];

    // Branch ফিল্টার - Flutter থেকে branch_code / branch যেটাই আসুক ধরবে
    const branchVal = branch_code || branch;
    if (branchVal) { sql += " AND branch_code = ?"; params.push(branchVal); }

    // Officer ফিল্টার - Collection Sheet থেকে officer_code আসবে
    if (officer_code) { sql += " AND officer_code = ?"; params.push(officer_code); }

    // Day ফিল্টার - Flutter থেকে day / meeting_day যেটাই আসুক ধরবে
    const dayVal = meeting_day || day;
    if (dayVal) { sql += " AND meeting_day = ?"; params.push(dayVal); }

    // Type ফিল্টার - Daily / Weekly
    const typeVal = samity_type || type;
    if (typeVal) { sql += " AND samity_type = ?"; params.push(typeVal); }

    sql += " ORDER BY id DESC";
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: 'Samity load failed' });
  }
});

// POST Save Samity
// POST Save Samity
app.post('/api/samity', async (req, res) => {
  try {
    const { branch_code, officer_code, officer_name, samity_code, samity_name, block_group, leader_name, leader_mobile, meeting_day, samity_type } = req.body;

    await db.query(
      "INSERT INTO samity_setup (branch_code, officer_code, officer_name, samity_code, samity_name, block_group, leader_name, leader_mobile, meeting_day, samity_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [branch_code, officer_code, officer_name, samity_code, samity_name, block_group, leader_name, leader_mobile, meeting_day, samity_type || 'Weekly']
    );
    res.json({ message: 'Samity Saved' });
  } catch (err) {
    console.log(err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'এই Samity Code আগেই আছে' });
    }
    res.status(500).json({ message: 'Save failed' });
  }
});

app.get('/api/field-officers', async (req, res) => {
  try {
    const branch_code = (req.query.branch_code || req.query.branch || '').toString();
    let sql = "SELECT * FROM field_officers WHERE 1=1";
    let params = [];
    if (branch_code) {
      sql += " AND branch_code = ?";
      params.push(branch_code);
    }
    sql += " ORDER BY officer_name ASC";
    const [rows] = await db.query(sql, params);
    res.json(rows);
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.post('/api/field-officers', async (req, res) => {
  try {
    const { branch_code, officer_code, officer_name, mobile } = req.body;
    await db.query("INSERT INTO field_officers (branch_code, officer_code, officer_name, mobile) VALUES (?,?,?,?)", [branch_code, officer_code, officer_name, mobile]);
    res.status(200).json({ message: 'Saved' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});
app.put('/api/field-officers/:id', async (req, res) => {
  try {
    const { branch_code, officer_code, officer_name, mobile } = req.body;
    await db.query("UPDATE field_officers SET branch_code=?, officer_code=?, officer_name=?, mobile=? WHERE id=?", [branch_code, officer_code, officer_name, mobile, req.params.id]);
    res.json({ message: 'Updated' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

app.delete('/api/field-officers/:id', async (req, res) => {
  try {
    await db.query("DELETE FROM field_officers WHERE id=?", [req.params.id]);
    res.json({ message: 'Deleted' });
  } catch (e) { res.status(500).json({ error: e.message }); }
});

// ✅ একটাই সার্ভার লিসেন - আগের ডাবল লিসেন বাগ ফিক্স করা হলো
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`মাল্টি-সমিতি ব্যাকএন্ড সার্ভার চালু হয়েছে পোর্ট: ${PORT}`));