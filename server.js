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
        collected: row.collected ?? 0,
        savingsInput: row.savingsInput ??0,
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
    const sql = "SELECT * FROM active_loans WHERE status = 'Active'";
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
app.post('/api/save-draft-collection', async (req, res) => {
  const { members } = req.body;
  if (!members || members.length === 0) {
    return res.status(400).json({ error: "পর্যাপ্ত ডাটা নেই!" });
  }

  try {
    for (const member of members) {
      const kisti = parseFloat(member.collected || 0);
      const sanchay = parseFloat(member.savingsInput || 0);

      // isSavedToday যদি VARCHAR হয় তবেই 'pending' চলবে
      const sql = `UPDATE active_loans SET collected = ?, savingsInput = ?, isSavedToday = 'pending' WHERE id = ?`;
      await db.query(sql, [kisti, sanchay, member.id]);
    }
    res.status(200).json({ message: "Pending হয়েছে!" });
  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "কিছু সদস্যের ডাটা সেভ করা যায়নি!" });
  }
});
app.post('/api/final-submit-collection', async (req, res) => {
  const { members } = req.body;
  if (!members || members.length === 0) {
    return res.status(400).json({ error: "পর্যাপ্ত ডাটা নেই!" });
  }

  try {
    for (const member of members) {
      const kisti = parseFloat(member.collected || 0);
      const sanchay = parseFloat(member.savingsInput || 0);
      const closingDue = parseFloat(member.closing_due ?? member.accumulatedDue ?? 0);

      // ✅ Final - এখন বকেয়া ফাইনাল + লক + মোট আদায়ে যোগ
      const sql = `UPDATE active_loans SET collected = ?, savingsInput = ?, accumulatedDue = ?, totalCollected = totalCollected + ?, isSavedToday = 'true' WHERE id = ?`;

      await db.query(sql, [kisti, sanchay, closingDue, kisti, member.id]);
    }

    res.status(200).json({ message: "Final Submit হয়ে লক হয়েছে!" });

  } catch (err) {
    console.log(err);
    res.status(500).json({ error: "কিছু সদস্যের ডাটা সেভ করা যায়নি!" });
  }
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

// 🔄 ৯. পরবর্তী দিন আপডেট
// Flutter /api/day-end ডাকে, তাই এই নামেও চালু রাখতে হবে
app.post('/api/day-end', async (req, res) => {
  try {
    let { company_id, next_date } = req.body;
    let cid = company_id || 'COM101';

    // ✅ তারিখটা হাতে ভেঙে নেওয়া - "2026-11-03" / "3-11-2026" ২টাই চলবে
    let parts = String(next_date).split('-');
    let isoDate = parts[0].length === 4 ? next_date : `${parts[2]}-${parts[1].padStart(2,'0')}-${parts[0].padStart(2,'0')}`;

    await db.query('START TRANSACTION');

    let [sysRows] = await db.query(`SELECT system_date FROM system_settings WHERE company_id = ?`, [cid]);
    let currDate = sysRows[0]?.system_date;
    if (currDate) {
      let c = new Date(currDate); let n = new Date(isoDate);
      let diffDays = Math.round((n - c) / (1000*60*60*24));
      if (diffDays < 1) {
        await db.query('ROLLBACK');
        return res.status(400).json({ success: false, error: 'পরের তারিখই হইতে হবে! এখন আছে ' });
      }
    }

    // ✅ বকেয়া সবার জন্য - আপনার হিসাব
    try { await db.query(`UPDATE active_loans SET totalSavings = totalSavings + savingsInput WHERE company_id = ?`, [cid]); } catch(e) {}
    await db.query(`UPDATE active_loans SET totalDue = GREATEST(0, totalDue - collected) WHERE company_id = ?`, [cid]);
    // ✅ খালি এই ১টা লাইন বসান - টিক না দেওয়া সদস্যের বকেয়া বাড়বে
    await db.query(`UPDATE active_loans SET accumulatedDue = accumulatedDue + targetToday WHERE company_id = ? AND (isSavedToday != 'true' OR isSavedToday IS NULL)`, [cid]);
    // ✅ খালি আদায় 0 হবে, টার্গেট 0 হবে না
    await db.query(`UPDATE active_loans SET collected = 0, savingsInput = 0, vsInput = 0, isSavedToday = 'false' WHERE company_id = ?`, [cid]);
    // ✅ WP 120 ওভার হইলে খালি তখন টার্গেট 0
    await db.query(`UPDATE active_loans SET targetToday = 0 WHERE company_id = ? AND status = 'Active' AND DATEDIFF(?, disburseDate) >= 120`, [cid, isoDate]);

    await db.query(`UPDATE system_settings SET system_date = ? WHERE company_id = ?`, [isoDate, cid]);
    await db.query('COMMIT');
    return res.status(200).json({ success: true, message: 'Day End হইছে' });
  } catch (err) {
    await db.query('ROLLBACK');
    return res.status(500).json({ success: false, error: err.message });
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
// 📝 নতুন সদস্য ভর্তি এবং পুরাতন রানিং সদস্য এন্ট্রি লজিক API
app.post('/api/member/register', async (req, res) => {
  try {
    // 1. Flutter যেই নামেই পাঠাক, সব নাম ধরো - না হইলে branch/samity NULL যাবে
    const branch_code = req.body.branch_code || req.body.branchCode || req.body.branch || null;
    const samity_code = req.body.samity_code || req.body.samityCode || req.body.samity || null;
    const field_officer = req.body.field_officer || req.body.officer_name || req.body.officer || req.body.fieldOfficer || '';
    const finalOfficer = field_officer;

    let { name, guardianName, phone, address, isOldMember, totalSavings, totalDue, disburseDate, disburseAmount, company_id } = req.body;

    // ফোনের মাইনাস / স্পেস কেটে দাও
    phone = (phone || '').toString().replace(/[^0-9+]/g, '').replace(/^\+?880/, '0');

    if (!name) return res.status(400).json({ error: 'নাম দিতে হবে' });

    // 2. অটো ১১ ডিজিটের Member ID - এইটাই আপনার চাওয়া জিনিস
    let id = (req.body.id || '').toString().trim();

    if (!id) {
      // ডাটাবেজে এখন সবচেয়ে বড় ১১ ডিজিটের ID কত, ওইটা খুঁজো
      // খালি id / rasel এর স্পেস ওয়ালা id কে বাদ দাও
      const [rows] = await db.query(
        "SELECT MAX(CAST(id AS UNSIGNED)) as maxId FROM members WHERE id REGEXP '^[0-9]+$'"
      );
      let maxId = rows[0]?.maxId || 0;

      // যদি টেবিল একদম খালি হয়, তাহলে এইখান থেকে শুরু হবে
      if (maxId === 0) maxId = 83068000000;

      // পরের সিরিয়াল = আগেরটা + 1, যেমন 8306857295 -> 8306857296
      const nextId = Number(maxId) + 1;
      id = String(nextId).padStart(11, '0');
      console.log("Auto Member ID Generated:", id, "Previous Max:", maxId);
    }

    await db.query("INSERT INTO members (id, name, guardianName, phone, address, branch_code, samity_code, field_officer) VALUES (?,?,?,?,?,?,?,?)",
      [id, name, guardianName, phone, address, branch_code, samity_code, finalOfficer]);

    if (isOldMember === true || isOldMember === 'true') {
      const finalCompanyId = company_id || 'COM101';
      await db.query(`INSERT INTO active_loans (\`id\`, \`name\`, \`disburseDate\`, \`disburseAmount\`, \`totalDue\`, \`totalSavings\`, \`company_id\`, \`branch_code\`, \`samity_code\`) VALUES (?,?,?,?,?,?,?,?,?)`,
        [id, name, disburseDate, disburseAmount, totalDue, totalSavings, finalCompanyId, branch_code, samity_code]);
    }

    // 3. নতুন ID টা অ্যাপকে ফেরত দাও
    res.status(200).json({ message: "সদস্য সফলভাবে রেজিস্টার হয়েছে!", id: id, member_id: id });
  } catch (err) {
    console.log("member register error:", err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(500).json({ error: "এই ID টা আগে আছে, আবার SAVE দেন, নতুন ID হয়ে যাবে" });
    }
    res.status(500).json({ error: "ডাটাবেজে সদস্য সেভ করতে ব্যর্থ! " + err.message });
  }
});
// ===== LOAN PROPOSAL SYSTEM =====
// ===== LOAN PROPOSAL SYSTEM =====

// ১. Active Member খোঁজা - Loan এর জন্য
app.get('/api/members/active-search', async (req, res) => {
  try {
    const q = req.query.q || '';
    const [rows] = await db.query(
      `SELECT id, name, phone, branch_code, samity_code, status 
       FROM members 
       WHERE status = 'Active' 
       AND (CAST(id AS CHAR) LIKE ? OR name LIKE ? OR phone LIKE ?)
       ORDER BY name ASC LIMIT 20`,
      [`%${q}%`, `%${q}%`, `%${q}%`]
    );
    res.json(rows);
  } catch (err) {
    console.error('SEARCH ERROR:', err.message);
    res.status(500).json({ error: 'Search failed', detail: err.message });
  }
});

// ২. নতুন Loan Proposal জমা দেওয়া
// ===== ১. Loan Proposal জমা - পুরান স্টাইল (await db.query) + নতুন সব ফিল্ড =====
app.post('/api/loan-proposals', async (req, res) => {
  try {
    const b = req.body;

    // ✅ Validation - পুরানটার মতো
    if (!b.member_id || !b.branch_code || !b.samity_code) {
      return res.status(400).json({ error: "Branch / Samity / Member সব লাগবে" });
    }

    // ✅ পুরান + নতুন ২টার সাথেই চলবে
    // পুরান Flutter পাঠায় loan_amount, নতুন Flutter পাঠায় proposed_loan_amount
    const proposedAmt = parseFloat(b.proposed_loan_amount ?? b.loan_amount) || 0;
    const appliedAmt = parseFloat(b.applied_loan_amount ?? b.loan_amount) || 0;

    // ✅ আপনার পুরান লজিক - Daily / Weekly হিসাব
    const installment_type = b.installment_type || 'Daily';
    const service_charge_percent = installment_type === 'Weekly' ? 40 : 20;
    const total_installments = installment_type === 'Weekly' ? 28 : 120;
    const totalDue = proposedAmt + (proposedAmt * service_charge_percent / 100);
    const perInstallment = total_installments > 0 ? totalDue / total_installments : 0;

    // ✅ VS / GS - হাতে লেখা, আপনার পুরান লজিকই
    const vs_amount = parseFloat(b.vs_amount) || 0;
    const gs_amount = parseFloat(b.gs_amount) || 0;

    const status = b.recommend_approve === 'Approve' ? 'Approved' : 'Pending';

    // ✅ আপনার পুরান স্টাইল - await db.query
    const [result] = await db.query(
      `INSERT INTO loan_proposals
        (company_id, member_id, member_name, branch_code, branch_name, officer_code, officer_name, samity_code, samity_name,
         category_name, product_name, loan_purpose, installment_type, total_installments, service_charge_percent,
         total_due, per_installment, loan_amount,
         applied_loan_amount, applied_date, applied_comment,
         proposed_loan_amount, proposed_date, proposed_comment, proposed_by,
         recommend_approve, approved_loan_amount, approval_date, approval_comment, approved_by,
         recommendation_date, recommended_by,
         vs_amount, gs_amount,
         guarantor_branch, guarantor_officer, guarantor_member_id,
         guarantor_name, guarantor_mobile, guarantor_other_id, guarantor_relation, guarantor_nid, guarantor_ratio, guarantor_smart_id,
         status, created_at)
       VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,NOW())`,
      [
        b.company_id || 'COM101',
        b.member_id, b.member_name,
        b.branch_code, b.branch_name || '',
        b.officer_code || '', b.officer_name || '',
        b.samity_code, b.samity_name || '',
        b.category_name || '', b.product_name || '', b.loan_purpose || '',
        installment_type, total_installments, service_charge_percent,
        totalDue, perInstallment, proposedAmt,
        appliedAmt, b.applied_date || null, b.applied_comment || '',
        proposedAmt, b.proposed_date || null, b.proposed_comment || '', b.proposed_by || '',
        b.recommend_approve || 'Please Select',
        parseFloat(b.approved_loan_amount) || 0, b.approval_date || null, b.approval_comment || '', b.approved_by || '',
        b.recommendation_date || null, b.recommended_by || '',
        vs_amount, gs_amount,
        b.guarantor_branch || '', b.guarantor_officer || '', b.guarantor_member_id || '',
        b.guarantor_name || '', b.guarantor_mobile || '', b.guarantor_other_id || '',
        b.guarantor_relation || '', b.guarantor_nid || '', parseFloat(b.guarantor_ratio) || 0, b.guarantor_smart_id || '',
        status
      ]
    );

    res.json({ message: 'Proposal Created', id: result.insertId, success: true });

  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Proposal failed: ' + err.message });
  }
});

// ===== ২. সব Proposal এর লিস্ট - আপনার পুরানটাই, খালি company_id যোগ করছি =====
app.get('/api/loan-proposals', async (req, res) => {
  try {
    const { status, company_id, branch_code, officer_code, samity_code, category_name, product_name, from_date, to_date, search } = req.query;
    console.log("Proposal Request:", status, company_id, branch_code, officer_code, samity_code, category_name, product_name, from_date, to_date, search);
    let query = "SELECT * FROM loan_proposals WHERE 1=1";
    let params = [];

    if (company_id) {
      if (company_id === 'COM101') {
        query += " AND (company_id = ? OR company_id = '101' OR company_id = 'COM101')";
        params.push(company_id);
      } else {
        query += " AND company_id = ?";
        params.push(company_id);
      }
    }
    if (branch_code) { query += " AND branch_code = ?"; params.push(branch_code); }
    if (officer_code) { query += " AND officer_code = ?"; params.push(officer_code); }
    if (samity_code) { query += " AND samity_code = ?"; params.push(samity_code); }
    if (category_name) { query += " AND category_name = ?"; params.push(category_name); }
    if (product_name) { query += " AND product_name = ?"; params.push(product_name); }
    if (status && status != 'All') { query += " AND status = ?"; params.push(status); }
    if (from_date) { query += " AND DATE(created_at) >= ?"; params.push(from_date); }
    if (to_date) { query += " AND DATE(created_at) <= ?"; params.push(to_date); }
    if (search) { query += " AND (member_name LIKE ? OR member_id LIKE ? OR loan_purpose LIKE ?)"; params.push(`%${search}%`, `%${search}%`, `%${search}%`); }
    query += " ORDER BY created_at DESC";
    const [rows] = await db.query(query, params);
    res.json(rows);
  } catch (err) { res.status(500).json({ error: 'Fetch failed' }); }
});

// ===== ৩. Approve / Reject - পুরান স্টাইলে =====
app.put('/api/loan-proposals/:id/:action', async (req, res) => {
  try {
    const { id, action } = req.params;
    const newStatus = action === 'approve' ? 'Approved' : 'Rejected';
    const [result] = await db.query(
      `UPDATE loan_proposals SET status = ? WHERE id = ?`,
      [newStatus, id]
    );
    res.json({ success: true, affected: result.affectedRows });
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: 'Update failed' });
  }
});

// ===== ৪. Samity অনুযায়ী Member - পুরান স্টাইলে await দিয়া =====
app.get('/api/members/by-samity', async (req, res) => {
  try {
    const { branch_code, samity_code, company_id } = req.query;
    const samityOnly = (samity_code || '').toString().split(' ')[0];
    console.log("Member Request - Branch:", branch_code, "Samity:", samityOnly, "Company:", company_id);

    // ✅ ১. আগে দেখে নিবো members টেবিলে আসলে কোন কোন কলাম আছে
    const [cols] = await db.query(`SHOW COLUMNS FROM members`);
    const colNames = cols.map(c => c.Field);
    console.log("Members Columns:", colNames);

    const hasCompany = colNames.includes('company_id');
    const hasBranch = colNames.includes('branch_code');
    const hasSamity = colNames.includes('samity_code');
    const hasId = colNames.includes('id');

    const orderBy = hasId ? `ORDER BY CAST(id AS UNSIGNED)` : ``;

    // ✅ ২. যেই কলাম আছে, খালি ওইটা দিয়াই WHERE বানাবো
    const buildWhere = (useSamity, useBranch) => {
      let where = `1=1`;
      let params = [];
      if (hasCompany) { where += ` AND (company_id = ? OR company_id = 'COM101' OR company_id = '101')`; params.push(company_id || '101'); }
      if (useSamity && hasSamity) { where += ` AND (samity_code = ? OR samity_code = ? OR samity_code LIKE ?)`; params.push(samity_code, samityOnly, `${samityOnly}%`); }
      if (useBranch && hasBranch) { where += ` AND (branch_code = ? OR branch_code = '01' OR branch_code = '02')`; params.push(branch_code); }
      return { where, params };
    };

    // ✅ Step-1: আপনার Logic - Samity দিয়া
    let q1 = buildWhere(true, false);
    let [rows1] = await db.query(`SELECT * FROM members WHERE ${q1.where} ${orderBy}`, q1.params);
    console.log("Member Found Step-1:", rows1.length);

    // ✅ Step-2: আপনার Logic - শুধু Branch দিয়া
    let rows2 = [];
    if (rows1.length === 0) {
      let q2 = buildWhere(false, true);
      [rows2] = await db.query(`SELECT * FROM members WHERE ${q2.where} ${orderBy}`, q2.params);
      console.log("Member Found Step-2 (Only Branch):", rows2.length);
    }

    if (rows1.length > 0) return res.json(rows1);
    if (rows2.length > 0) return res.json(rows2);

    // ✅ Step-3: আপনার Logic - খালি Samity + Branch, Company বাদ দিয়া - কারণ Company কলামই নাই
    let q3 = buildWhere(true, true);
    // Company থাকলে Step-3 এ Company বাদ দিয়া আবার চেষ্টা করবো
    if (hasCompany) {
      let [rows3] = await db.query(`SELECT * FROM members WHERE samity_code = ? ${orderBy}`, [samityOnly]);
      console.log("Member Found Step-3 (Only Samity):", rows3.length);
      return res.json(rows3);
    }

    res.json([]);
  } catch (err) {
    console.error(err);
    res.status(500).json({ error: err.message });
  }
});
// ৪. Approve / Reject
app.put('/api/loan-proposals/:id/:action', async (req, res) => {
  try {
    const { id, action } = req.params;
    const newStatus = action === 'approve' ? 'Approved' : 'Rejected';
    await db.query("UPDATE loan_proposals SET status = ? WHERE id = ?", [newStatus, id]);
    res.json({ message: newStatus });
  } catch (err) {
    res.status(500).json({ error: 'Update failed' });
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
app.get('/api/collection-sheet-full', (req, res) => {
    const company_id = req.query.company_id || 'COM101';
    const officer_code = (req.query.officer_code || '').toString();
    const officer_name = (req.query.officer_name || req.query.officer || '').toString();
    const samity_code = (req.query.samity_code || req.query.samity || '').toString().split(' ')[0];
    const branch_code = (req.query.branch_code || '').toString();

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

    if (branch_code) {
        sql += ` AND m.branch_code = ?`;
        params.push(branch_code);
    }

    if (officer_code) {
        sql += ` AND (al.officer_code = ? OR m.field_officer = ?)`;
        params.push(officer_code, officer_name);
    }

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
            const prevArrears = parseFloat(row.accumulatedDue) || 0;
            const new_due = targetToday;
            const closing_due = prevArrears + new_due - collected;
            const savingsInput = parseFloat(row.savingsInput) || 0;
            const gs_balance = parseFloat(row.totalSavings) || 0;
            const vs_balance = 0;
            const vs_collected = 0;
            const loan_pa = pa_balance;
            const loan_sc = sc_balance;
            const accumulatedDue = prevArrears;
            const totalCollected = parseFloat(row.totalCollected) || 0;
            const total_balance = totalDue - totalCollected;
            return {
                ...row,
                pa_balance: pa_balance,
                sc_balance: sc_balance,
                total_balance: totalDue - totalCollected,
                loan_collection_pa: Math.round(collected * pa_ratio),
                loan_collection_sc: Math.round(collected * (1-pa_ratio)),
                new_due: new_due,
                closing_due: closing_due,
                previous_due: prevArrears,
                accumulatedDue: prevArrears,
                gs_balance: parseFloat(row.totalSavings) || 0,
                vs_balance: 0,
                vs_collected: 0,
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
    const { branch_code, officer_code, company_id } = req.query;
    console.log("Samity Request - Branch:", branch_code, "Officer:", officer_code, "Company:", company_id);

    let comp = company_id || '101';
    if (comp === 'COM101') comp = '101';

    // ✅ ১. প্রথমে ঠিকঠাক যেভাবে চাইছেন ওইভাবে চেষ্টা করবো
    let [rows] = await db.query(
      `SELECT id, branch_code, samity_code, samity_name, block_group, leader_name, leader_mobile, meeting_day, status, company_id, officer_code, officer_name, samity_type
       FROM samity_setup
       WHERE (company_id = ? OR company_id = 'COM101' OR company_id = '101')
       AND (branch_code = ? OR branch_code = '01' OR branch_code = '02')
       AND (officer_code = ? OR officer_name = ? OR officer_name LIKE ?)
       ORDER BY samity_code`,
      [comp, branch_code, officer_code, officer_code, `%${officer_code}%`]
    );

    console.log("Samity Found Step-1:", rows.length);

    // ✅ ২. তাও না পাইলে শুধু Officer দিয়া খুঁজবো - Branch বাদ দিয়া
    if (rows.length === 0) {
      [rows] = await db.query(
        `SELECT id, branch_code, samity_code, samity_name, block_group, leader_name, leader_mobile, meeting_day, status, company_id, officer_code, officer_name, samity_type
         FROM samity_setup
         WHERE (officer_code = ? OR officer_name = ? OR officer_name LIKE ?)
         ORDER BY samity_code`,
        [officer_code, officer_code, `%${officer_code}%`]
      );
      console.log("Samity Found Step-2 (Only Officer):", rows.length);
    }

    // ✅ ৩. তাও না পাইলে শুধু Branch দিয়া খুঁজবো - সব সমিতি দিয়া দিবো
    if (rows.length === 0) {
      [rows] = await db.query(
        `SELECT id, branch_code, samity_code, samity_name, block_group, leader_name, leader_mobile, meeting_day, status, company_id, officer_code, officer_name, samity_type
         FROM samity_setup
         WHERE branch_code = ? OR branch_code = '01' OR branch_code = '02'
         ORDER BY samity_code`,
        [branch_code]
      );
      console.log("Samity Found Step-3 (Only Branch):", rows.length);
    }

    res.json(rows);
  } catch (err) {
    console.error("Samity Error:", err);
    res.status(500).json({ error: err.message });
  }
});

// POST Save Samity
app.post('/api/samity', async (req, res) => {
  try {
    // ঠিক - সবগুলা নাম মিলায় দিলাম
const branch_code = (req.body.branch_code || req.body.branch || '').toString().split(' ')[0];
const officer_code = req.body.officer_code || '';
const officer_name = req.body.officer_name || '';
const samity_code = req.body.samity_code || '';
const samity_name = req.body.samity_name || '';
const block_group = req.body.block_group || '';
const leader_name = req.body.leader_name || '';
const leader_mobile = req.body.leader_mobile || ''; // এই লাইনটাই ছিল না, এইটাই আসল রোগ
const meeting_day = req.body.meeting_day || req.body.samity_day || '';
const samity_type = req.body.samity_type || 'Weekly';

    await db.query(
      "INSERT INTO samity_setup (branch_code, officer_code, officer_name, samity_code, samity_name, block_group, leader_name, leader_mobile, meeting_day, samity_type) VALUES (?,?,?,?,?,?,?,?,?,?)",
      [branch_code, officer_code, officer_name, samity_code, samity_name, block_group, leader_name, leader_mobile, meeting_day, samity_type || 'Weekly']
    );
    res.json({ message: 'Samity Saved' });
  } catch (err) {
    console.log("samity save error:", err);
    if (err.code === 'ER_DUP_ENTRY') {
      return res.status(400).json({ message: 'এই Samity Code আগেই আছে' });
    }
    res.status(500).json({ message: "samity save error: " + err.message });
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
// FINAL DELETE - Samity
app.delete('/api/samity/:id', async (req, res) => {
  try {
    const id = req.params.id;
    console.log("DELETE Samity id:", id);
    const [result] = await db.query("DELETE FROM samity_setup WHERE id = ?", [id]);
    if (result.affectedRows === 0) {
      return res.status(404).json({ message: 'এই সমিতি পাওয়া যায় নাই' });
    }
    res.json({ message: 'Samity Deleted' });
  } catch (err) {
    console.log("samity delete error:", err);
    res.status(500).json({ message: "samity delete error: " + err.message });
  }
});
// ===== LOAN DISBURSE SYSTEM =====
app.get('/api/loan-proposals-approved', async (req, res) => {
  try {
    const [rows] = await db.query("SELECT * FROM loan_proposals WHERE status = 'Approved' ORDER BY created_at DESC");
    res.json(rows);
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ Search - ভিডিওর মতো Member + Approval No দিয়া খুঁজবে, সব Auto Fill হবে
app.get('/api/loan-disburse/search', async (req, res) => {
  try {
    const { member_id, approval_no } = req.query;
    // ১. Proposal খুঁজবো - Approval No / Member ID যেকোনো একটা দিয়াই
    let [proposals] = await db.query(
      `SELECT * FROM loan_proposals WHERE (id = ? OR approval_no = ? OR member_id = ?) ORDER BY id DESC LIMIT 1`,
      [approval_no, approval_no, member_id]
    );
    if (proposals.length === 0) return res.json({ found: false, message: 'Approval পাওয়া যায় নাই' });
    const p = proposals[0];

    // ২. Member এর Savings / Share - members টেবিল থেকে
    let savings = 0, share = 100;
    try {
      const [m] = await db.query(`SELECT * FROM members WHERE id = ? OR member_id = ? LIMIT 1`, [p.member_id, p.member_id]);
      if (m.length > 0) {
        savings = Number(m[0].totalSavings ?? m[0].savings ?? m[0].gs_balance ?? 0) + Number(m[0].vs_balance ?? 0);
        share = Number(m[0].share_balance ?? 100);
      }
    } catch (e) { console.log("Member savings skip:", e.message); }

    res.json({ found: true, proposal: p, savings_balance: savings, share_balance: share });
  } catch (err) { res.status(500).json({ error: err.message }); }
});

// ✅ Disburse - আপনার পুরান Logic + ভিডিওর Field গুলা
app.post('/api/loan-disburse', async (req, res) => {
  try {
    const b = req.body;
    const amount = Number(b.loan_amount || b.disburse_amount || 0);
    const type = b.loan_type || b.installment_type || 'Daily';
    const duration = Number(b.duration_month || (type === 'Weekly' ? 7 : 5));

    // ✅ আপনার ফাইনাল নিয়ম - Daily: 20% লাভ, 120 কিস্তি | Weekly: 40% লাভ, 28 কিস্তি
    const profitPct = type === 'Weekly' ? 40 : 20;
    const instNo = type === 'Weekly' ? 28 : 120;
    const totalSC = Math.round(amount * profitPct / 100);
    const totalRepay = amount + totalSC;
    const totalInst = Math.round(totalRepay / instNo);
    const principalInst = Math.round(amount / instNo);
    const scInst = Math.round(totalSC / instNo);
    const welfare = Math.round(amount * 0.01); // ভিডিও: 20000 -> 200

    // ✅ 1st Installment Date: Disburse Date + 2 দিন (ভিডিও: 20-11 -> 22-11)
    const dDate = new Date(b.disburse_date);
    const firstDate = new Date(dDate); firstDate.setDate(firstDate.getDate() + 2);
    const firstStr = firstDate.toISOString().slice(0, 10);

    // ১. Disburse টেবিলে ঢুকাবো
    const [r] = await db.query(
      `INSERT INTO loan_disbursements
      (proposal_id, approval_no, member_id, member_name, branch_code, samity_code, loan_name, disburse_amount, duration_month, yearly_sc_rate, total_service_charge, total_repay, installment_type, total_installment_no, total_installment, principal_installment, sc_installment, welfare_fund, savings_balance, share_balance, disburse_date, first_installment_date, transaction_type, status)
      VALUES (?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?,?, 'Disbursed')`,
      [b.proposal_id, b.approval_no || b.proposal_id, b.member_id, b.member_name, b.branch_code || '02', b.samity_code || '', b.loan_name || (type === 'Weekly' ? 'Weekly Loan' : 'Daily Loan 5 Months'), amount, duration, type === 'Weekly' ? 40 : 40, totalSC, totalRepay, type, instNo, totalInst, principalInst, scInst, b.welfare_fund || welfare, b.savings_balance || 0, b.share_balance || 100, b.disburse_date, firstStr, b.transaction_type || 'Cash']
    );
    const disbId = r.insertId;

    // ২. Schedule বানাবো - Collection Sheet এ যাবে
    let cur = new Date(firstDate);
    for (let i = 1; i <= instNo; i++) {
      // শুক্রবার বাদ - Daily হইলে
      if (type === 'Daily' && cur.getDay() === 5) { cur.setDate(cur.getDate() + 1); i--; continue; }
      await db.query(
        `INSERT INTO loan_schedules (disbursement_id, proposal_id, member_id, installment_no, installment_date, principal_amount, sc_amount, total_amount) VALUES (?,?,?,?,?,?,?,?)`,
        [disbId, b.proposal_id, b.member_id, i, cur.toISOString().slice(0, 10), principalInst, scInst, totalInst]
      );
      cur.setDate(cur.getDate() + (type === 'Weekly' ? 7 : 1));
    }

    // ৩. Proposal এর Status Disbursed করবো - যাতে আবার Disburse না হয়
    try { await db.query(`UPDATE loan_proposals SET status = 'Disbursed' WHERE id = ?`, [b.proposal_id]); } catch (e) {}

    res.json({ success: true, disbursement_id: disbId, total_repay: totalRepay, total_installment: totalInst, first_installment_date: firstStr });
  } catch (err) { console.error(err); res.status(500).json({ error: err.message }); }
});
// Final রুমের লিস্ট - খালি Pending রা আসবে
app.get('/api/get-final-submit-data', (req, res) => {
  db.query(`SELECT * FROM active_loans WHERE isSavedToday = 'pending' AND company_id = ?`, ['COM101'], (err, results) => {
    if (err) return res.status(500).json({ error: err.message });
    res.json(results);
  });
});

// Final Submit - Pending -> Final + লক
app.post('/api/lock-collection', async (req, res) => {
  const { members, date, company_id } = req.body;
  const cid = company_id || 'COM101';

  if (!members || members.length === 0) {
    return res.status(200).json({ message: "কোন সদস্য নেই!" });
  }

  // db.promise() ব্যবহার করো, তাহলে await কাজ করবে
  const conn = await db.promise().getConnection();
  
  try {
    await conn.beginTransaction();

    // 1. Safe Date নাও
    const [dateRows] = await conn.query(
      "SELECT DATE_FORMAT(system_date, '%Y-%m-%d') as s_date FROM system_settings WHERE company_id = ?",
      [cid]
    );
    const safeDate = dateRows.length > 0 ? dateRows[0].s_date : (date || new Date().toISOString().split('T')[0]);

    // 2. কারা already locked চেক করো
    const memberIds = members.map(m => m.id);
    const [dbMembers] = await conn.query(
      "SELECT id, isSavedToday FROM active_loans WHERE id IN (?)",
      [memberIds]
    );

    const pendingMembers = members.filter(fm => {
      const dbM = dbMembers.find(m => m.id === fm.id);
      return dbM && dbM.isSavedToday !== 'locked';
    });

    if (pendingMembers.length === 0) {
      await conn.rollback();
      return res.status(200).json({ message: "এই সদস্যগুলো আগেই সাবমিট করা হয়েছে।" });
    }

    let totalCollection = 0;
    let totalSavings = 0;

    // 3. প্রতিটা মেম্বার আপডেট করো
    for (const member of pendingMembers) {
      const kisti = parseFloat(member.collected || 0);
      const sanchay = parseFloat(member.savingsInput || 0);
      const targetToday = parseFloat(member.targetToday || 0);
      const todaysDue = targetToday > kisti ? (targetToday - kisti) : 0;

      totalCollection += kisti;
      totalSavings += sanchay;

      await conn.query(
        `UPDATE active_loans SET 
           totalSavings = totalSavings + ?,
           totalCollected = totalCollected + ?,
           totalDue = GREATEST(totalDue - ?, 0),
           accumulatedDue = accumulatedDue + ?,
           isSavedToday = 'locked',
           type = (CASE WHEN (totalDue - ?) <= 0 THEN 'Savings Only' ELSE type END)
         WHERE id = ?`,
        [sanchay, kisti, kisti, todaysDue, kisti, member.id]
      );

      await conn.query(
        "INSERT INTO loan_history (member_id, date, type, collected, savings, balance_effect) VALUES (?, ?, 'নিয়মিত আদায়', ?, ?, ?)",
        [member.id, safeDate, kisti, sanchay, `+৳${kisti + sanchay}`]
      );
    }

    // 4. সব ঠিক থাকলে তবেই টপশিট আপডেট করো
    await conn.query(
      `INSERT INTO daily_top_sheets (company_id, date, total_collection, total_savings) 
       VALUES (?, ?, ?, ?) 
       ON DUPLICATE KEY UPDATE 
       total_collection = total_collection + VALUES(total_collection), 
       total_savings = total_savings + VALUES(total_savings)`,
      [cid, safeDate, totalCollection, totalSavings]
    );

    await conn.commit();
    res.status(200).json({ message: "নতুন কালেকশন ফাইনাল সাবমিট হয়েছে!" });

  } catch (err) {
    await conn.rollback();
    console.error(err);
    res.status(500).json({ error: "সাবমিট ফেইল করেছে, কোনো ডাটা সেভ হয়নি!" });
  } finally {
    conn.release();
  }
});

// ✅ একটাই সার্ভার লিসেন - আগের ডাবল লিসেন বাগ ফিক্স করা হলো
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`মাল্টি-সমিতি ব্যাকএন্ড সার্ভার চালু হয়েছে পোর্ট: ${PORT}`));