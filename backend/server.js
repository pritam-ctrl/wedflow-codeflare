const express = require('express');
const cors = require('cors');
const { Pool } = require('pg');
const { Resend } = require('resend');
const crypto = require('crypto');
const jwt = require('jsonwebtoken');
const multer = require('multer');
const path = require('path');
const fs = require('fs');
require('dotenv').config();

const app = express();
const port = process.env.PORT || 5001;

// File upload configuration
const uploadsDir = path.join(__dirname, 'uploads');
if (!fs.existsSync(uploadsDir)) {
  fs.mkdirSync(uploadsDir, { recursive: true });
}

const storage = multer.diskStorage({
  destination: (req, file, cb) => {
    cb(null, uploadsDir);
  },
  filename: (req, file, cb) => {
    const uniqueSuffix = Date.now() + '-' + Math.round(Math.random() * 1E9);
    cb(null, file.fieldname + '-' + uniqueSuffix + path.extname(file.originalname));
  }
});

const upload = multer({ 
  storage: storage,
  limits: { fileSize: 10 * 1024 * 1024 }, // 10MB limit
  fileFilter: (req, file, cb) => {
    const allowedTypes = /jpeg|jpg|png|gif|pdf|doc|docx|mp4|mov|avi/;
    const extname = allowedTypes.test(path.extname(file.originalname).toLowerCase());
    const mimetype = allowedTypes.test(file.mimetype);
    if (extname && mimetype) {
      return cb(null, true);
    } else {
      cb(new Error('Invalid file type'));
    }
  }
});
const OTP_TTL_MINUTES = 10;
const OTP_RATE_LIMIT_WINDOW_MS = 60 * 1000;
const OTP_RATE_LIMIT_MAX_REQUESTS = 3;
const OTP_VERIFY_LIMIT_WINDOW_MS = 15 * 60 * 1000;
const OTP_VERIFY_LIMIT_MAX_ATTEMPTS = 5;
const otpRequestTracker = new Map();
const otpVerifyTracker = new Map();

// Middleware
app.use(cors());
app.use(express.json());

// PostgreSQL connection
const pool = new Pool({
  connectionString: process.env.DATABASE_URL || null,
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  database: process.env.DB_NAME,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
});

// Set pool in app for access in modular route handlers
app.set('pool', pool);

// Resend.com initialization
const resend = new Resend(process.env.RESEND_API_KEY);

function normalizeEmail(email) {
  return String(email || '').trim().toLowerCase();
}

function generateOTP(email) {
  // Demo user: admin@gmail.com always gets 123456
  if (normalizeEmail(email) === 'admin@gmail.com') {
    return '123456';
  }
  return crypto.randomInt(100000, 999999).toString();
}

function hashOTP(otp) {
  return crypto.createHash('sha256').update(String(otp)).digest('hex');
}

function getClientIp(req) {
  return req.headers['x-forwarded-for']?.split(',')[0]?.trim() || req.socket?.remoteAddress || 'unknown';
}

async function logUserActivity({ userId, action, description, req, workspaceId }) {
  if (!userId) return;

  try {
    await pool.query(
      'INSERT INTO user_activity_log (user_id, action, description, ip_address, user_agent, workspace_id) VALUES ($1, $2, $3, $4, $5, $6)',
      [userId, action, description, getClientIp(req), req.headers['user-agent'] || null, workspaceId || null]
    );
  } catch (error) {
    console.error('Error writing activity log:', error);
  }
}

function getRateLimitWindow(key, tracker, maxRequests, ttlMs) {
  const now = Date.now();
  const items = tracker.get(key) || [];
  const validItems = items.filter((timestamp) => now - timestamp < ttlMs);

  if (validItems.length >= maxRequests) {
    return { blocked: true, validItems };
  }

  validItems.push(now);
  tracker.set(key, validItems);
  return { blocked: false, validItems };
}

function getVerifyAttemptState(email, tracker) {
  const key = normalizeEmail(email);
  const now = Date.now();
  const existing = tracker.get(key) || { count: 0, firstAttemptAt: now };

  if (now - existing.firstAttemptAt > OTP_VERIFY_LIMIT_WINDOW_MS) {
    tracker.set(key, { count: 0, firstAttemptAt: now });
    return { count: 0, firstAttemptAt: now, blocked: false };
  }

  const updatedCount = existing.count + 1;
  tracker.set(key, { count: updatedCount, firstAttemptAt: existing.firstAttemptAt });

  return {
    count: updatedCount,
    firstAttemptAt: existing.firstAttemptAt,
    blocked: updatedCount > OTP_VERIFY_LIMIT_MAX_ATTEMPTS,
  };
}

function shouldBypassEmailDelivery(email) {
  const normalizedEmail = normalizeEmail(email);
  return process.env.NODE_ENV !== 'production' && /@example\.(com|net|org)$/i.test(normalizedEmail);
}

async function sendOTPEmail(email, otp) {
  if (shouldBypassEmailDelivery(email)) {
    console.warn(`Development mode: bypassing email delivery for ${email}. OTP: ${otp}`);
    return { devMode: true, otp };
  }

  try {
    const { data, error } = await resend.emails.send({
      from: 'WedFlow CRM <onboarding@resend.dev>',
      to: [email],
      subject: 'Your WedFlow CRM Verification Code',
      html: `
        <div style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
          <h2 style="color: #f5b719;">WedFlow CRM - Secure Access</h2>
          <p>Your verification code is:</p>
          <div style="background-color: #f5f5f5; padding: 20px; text-align: center; font-size: 32px; font-weight: bold; letter-spacing: 5px; margin: 20px 0;">
            ${otp}
          </div>
          <p>This code will expire in 10 minutes.</p>
          <p>If you didn't request this code, please ignore this email.</p>
          <p style="color: #666; font-size: 12px;">This is an automated message from WedFlow CRM</p>
        </div>
      `,
    });

    if (error) {
      console.error('Resend error:', error);
      throw error;
    }

    return data;
  } catch (error) {
    console.error('Error sending email:', error);
    throw error;
  }
}

async function sendReminderEmail(recipientEmail, subject, messageContent, reminderType, daysBeforeEvent) {
  console.log(`Attempting to send reminder email to: ${recipientEmail}`);
  console.log(`Subject: ${subject}`);
  console.log(`Development mode check: NODE_ENV = ${process.env.NODE_ENV}`);
  
  // Only bypass for example.com addresses, not for real emails
  if (shouldBypassEmailDelivery(recipientEmail)) {
    console.warn(`Development mode: bypassing reminder email delivery for ${recipientEmail} (example.com domain)`);
    return { devMode: true };
  }

  try {
    console.log(`Sending actual email via Resend.com to ${recipientEmail}...`);
    const emailSubject = subject || `WedFlow CRM - ${reminderType} Reminder`;
    const textContent = `WedFlow CRM - Reminder Notification\n\nReminder Type: ${reminderType.replace(/_/g, ' ').toUpperCase()}\nDays Before Event: ${daysBeforeEvent} day(s)\n\n${messageContent || 'This is an automated reminder from WedFlow CRM to keep you informed about your upcoming wedding event.'}\n\n---\nThis is an automated message from WedFlow CRM.\nFor support, please contact our team.`;
    
    const { data, error } = await resend.emails.send({
      from: 'WedFlow CRM <onboarding@resend.dev>',
      to: [recipientEmail],
      subject: emailSubject,
      text: textContent,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>WedFlow CRM Reminder</title>
        </head>
        <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #f5b719; margin: 0; font-size: 24px;">WedFlow CRM</h1>
              <p style="color: #666; margin: 5px 0 0; font-size: 14px;">Professional Wedding Event Management</p>
            </div>
            
            <div style="background-color: #fff9e6; border-left: 4px solid #f5b719; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <h2 style="color: #333; margin: 0 0 10px; font-size: 18px;">⏰ Reminder Notification</h2>
              <p style="margin: 0; color: #666; font-size: 14px;">You have an upcoming event reminder</p>
            </div>
            
            <div style="margin: 20px 0;">
              <p style="margin: 10px 0; color: #333; font-size: 14px;"><strong>Reminder Type:</strong> ${reminderType.replace(/_/g, ' ').toUpperCase()}</p>
              <p style="margin: 10px 0; color: #333; font-size: 14px;"><strong>Days Before Event:</strong> ${daysBeforeEvent} day(s)</p>
            </div>
            
            <div style="background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; border: 1px solid #e9ecef;">
              <p style="margin: 0; color: #333; font-size: 14px; line-height: 1.6;">${messageContent || 'This is an automated reminder from WedFlow CRM to keep you informed about your upcoming wedding event.'}</p>
            </div>
            
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e9ecef;">
              <p style="margin: 0; color: #999; font-size: 12px; text-align: center;">
                This is an automated message from WedFlow CRM.<br>
                For support, please contact our team.
              </p>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) {
      console.error('Resend error:', error);
      throw error;
    }

    console.log(`✅ Email successfully sent to ${recipientEmail}. Resend response:`, data);
    return data;
  } catch (error) {
    console.error('❌ Error sending reminder email:', error);
    throw error;
  }
}

async function sendWorkBriefEmail({ recipientEmail, professionalName, projectName, professionalRole, eventDate, venue, budget, contactPhone, projectBrief }) {
  console.log(`Attempting to send work brief email to: ${recipientEmail}`);

  if (shouldBypassEmailDelivery(recipientEmail)) {
    console.warn(`Development mode: bypassing work brief email delivery for ${recipientEmail}`);
    return { devMode: true };
  }

  const formattedBudget = budget ? `₹${Number(budget).toLocaleString('en-IN')}` : 'Not specified';
  const formattedDate = eventDate ? new Date(eventDate).toLocaleDateString('en-IN', { day: 'numeric', month: 'short', year: 'numeric' }) : 'Flexible / TBD';
  const formattedVenue = venue || 'To be discussed';
  const formattedPhone = contactPhone || 'Not provided';
  const briefText = projectBrief || 'No details provided.';

  try {
    const { data, error } = await resend.emails.send({
      from: 'WedFlow CRM <onboarding@resend.dev>',
      to: [recipientEmail],
      subject: `New Work Brief: ${projectName} - ${professionalRole}`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>New Work Brief - WedFlow CRM</title>
        </head>
        <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #0f0f11; color: #e5e5e5;">
          <div style="max-width: 600px; margin: 20px auto; background-color: #17171c; padding: 30px; border-radius: 8px; border: 1px solid #2e2e38; box-shadow: 0 4px 12px rgba(0,0,0,0.5);">
            <div style="border-bottom: 2px solid #D4AF37; padding-bottom: 16px; margin-bottom: 24px;">
              <h1 style="color: #D4AF37; margin: 0; font-size: 22px;">WedFlow CRM</h1>
              <p style="color: #a0a0b0; margin: 4px 0 0 0; font-size: 14px;">Freelancer Marketplace - New Work Opportunity</p>
            </div>
            
            <p style="font-size: 16px; color: #ffffff; margin-bottom: 16px;">Hello <strong>${professionalName}</strong>,</p>
            <p style="font-size: 14px; color: #cccccc; line-height: 1.5; margin-bottom: 24px;">
              You have received a new work brief proposal for the role of <strong>${professionalRole}</strong>.
            </p>

            <div style="background-color: #1f1f26; padding: 20px; border-radius: 6px; border: 1px solid #2f2f3d; margin-bottom: 24px;">
              <h2 style="color: #D4AF37; font-size: 18px; margin: 0 0 16px 0; border-bottom: 1px solid #2f2f3d; padding-bottom: 8px;">${projectName}</h2>
              
              <table style="width: 100%; border-collapse: collapse; font-size: 14px;">
                <tr>
                  <td style="padding: 6px 0; color: #888899; width: 140px;"><strong>Required Service:</strong></td>
                  <td style="padding: 6px 0; color: #ffffff;">${professionalRole}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #888899;"><strong>Event Date:</strong></td>
                  <td style="padding: 6px 0; color: #ffffff;">${formattedDate}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #888899;"><strong>Location / Venue:</strong></td>
                  <td style="padding: 6px 0; color: #ffffff;">${formattedVenue}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #888899;"><strong>Budget:</strong></td>
                  <td style="padding: 6px 0; color: #D4AF37; font-weight: bold;">${formattedBudget}</td>
                </tr>
                <tr>
                  <td style="padding: 6px 0; color: #888899;"><strong>Contact Phone:</strong></td>
                  <td style="padding: 6px 0; color: #ffffff;">${formattedPhone}</td>
                </tr>
              </table>
            </div>

            <div style="margin-bottom: 24px;">
              <h3 style="color: #D4AF37; font-size: 15px; margin: 0 0 8px 0;">Project Brief & Scope:</h3>
              <div style="background-color: #121216; padding: 16px; border-radius: 6px; border-left: 3px solid #D4AF37; color: #dddddd; font-size: 14px; white-space: pre-wrap; line-height: 1.6;">${briefText}</div>
            </div>

            <div style="border-top: 1px solid #2e2e38; margin-top: 24px; padding-top: 16px; font-size: 12px; color: #777788; text-align: center;">
              <p style="margin: 0;">This is an automated notification from WedFlow CRM Marketplace.</p>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) {
      console.error('❌ Resend work brief email error:', error);
      return { error };
    }

    console.log(`✅ Work brief email sent successfully to ${recipientEmail}:`, data);
    return { data };
  } catch (error) {
    console.error('❌ Error sending work brief email:', error);
    return { error };
  }
}

async function sendCrewAssignmentEmail(staffEmail, staffName, clientName, eventName, eventDate, venue, role) {
  console.log(`Attempting to send crew assignment email to: ${staffEmail}`);
  console.log(`Staff: ${staffName}, Role: ${role}, Event: ${eventName}`);
  
  // Only bypass for example.com addresses, not for real emails
  if (shouldBypassEmailDelivery(staffEmail)) {
    console.warn(`Development mode: bypassing crew assignment email delivery for ${staffEmail} (example.com domain)`);
    return { devMode: true };
  }

  try {
    console.log(`Sending crew assignment email via Resend.com to ${staffEmail}...`);
    const emailSubject = `New Crew Assignment - ${eventName} - ${clientName}`;
    
    const { data, error } = await resend.emails.send({
      from: 'WedFlow CRM <onboarding@resend.dev>',
      to: [staffEmail],
      subject: emailSubject,
      text: `Crew Assignment Notification\n\nDear ${staffName},\n\nYou have been assigned to a new event:\n\nClient: ${clientName}\nEvent: ${eventName}\nDate: ${eventDate}\nVenue: ${venue}\nRole: ${role}\n\nPlease confirm your availability and check your schedule for any conflicts.\n\n---\nThis is an automated message from WedFlow CRM.\nFor support, please contact our team.`,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>Crew Assignment - WedFlow CRM</title>
        </head>
        <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #f5b719; margin: 0; font-size: 24px;">WedFlow CRM</h1>
              <p style="color: #666; margin: 5px 0 0; font-size: 14px;">Professional Wedding Event Management</p>
            </div>
            
            <div style="background-color: #fff9e6; border-left: 4px solid #f5b719; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <h2 style="color: #333; margin: 0 0 10px; font-size: 18px;">📋 New Crew Assignment</h2>
              <p style="margin: 0; color: #666; font-size: 14px;">You have been assigned to a new event</p>
            </div>
            
            <div style="margin: 20px 0;">
              <p style="color: #333; font-size: 16px; margin: 0 0 10px;">Dear <strong>${staffName}</strong>,</p>
              <p style="color: #666; font-size: 14px; line-height: 1.6;">You have been assigned to the following event:</p>
            </div>
            
            <div style="background-color: #f9f9f9; padding: 20px; border-radius: 6px; margin: 20px 0;">
              <div style="margin-bottom: 15px;">
                <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Client</span>
                <div style="color: #333; font-size: 16px; font-weight: 600; margin-top: 5px;">${clientName}</div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Event</span>
                <div style="color: #333; font-size: 16px; font-weight: 600; margin-top: 5px;">${eventName}</div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Date</span>
                <div style="color: #333; font-size: 16px; font-weight: 600; margin-top: 5px;">${eventDate}</div>
              </div>
              
              <div style="margin-bottom: 15px;">
                <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Venue</span>
                <div style="color: #333; font-size: 16px; font-weight: 600; margin-top: 5px;">${venue}</div>
              </div>
              
              <div>
                <span style="color: #666; font-size: 12px; text-transform: uppercase; letter-spacing: 1px;">Your Role</span>
                <div style="color: #f5b719; font-size: 18px; font-weight: 700; margin-top: 5px;">${role}</div>
              </div>
            </div>
            
            <div style="margin: 30px 0; text-align: center;">
              <p style="color: #666; font-size: 14px; line-height: 1.6;">Please confirm your availability and check your schedule for any conflicts.</p>
            </div>
            
            <div style="border-top: 1px solid #e0e0e0; padding-top: 20px; margin-top: 30px;">
              <p style="color: #999; font-size: 12px; margin: 0;">This is an automated message from WedFlow CRM.</p>
              <p style="color: #999; font-size: 12px; margin: 5px 0 0;">For support, please contact our team.</p>
            </div>
          </div>
        </body>
        </html>
      `
    });

    if (error) {
      console.error('Resend API error:', error);
      throw error;
    }

    console.log('Crew assignment email sent successfully:', data);
    return data;
  } catch (error) {
    console.error('Error sending crew assignment email:', error);
    throw error;
  }
}

function generateToken(userId, email, role, workspaceId) {
  return jwt.sign(
    { userId, email, role, workspace_id: workspaceId },
    process.env.JWT_SECRET,
    { expiresIn: '30d' }
  );
}

async function sendReminderEmail(recipientEmail, subject, messageContent, reminderType, daysBeforeEvent) {
  console.log(`Attempting to send reminder email to: ${recipientEmail}`);
  console.log(`Subject: ${subject}`);
  console.log(`Development mode check: NODE_ENV = ${process.env.NODE_ENV}`);
  
  // Only bypass for example.com addresses, not for real emails
  if (shouldBypassEmailDelivery(recipientEmail)) {
    console.warn(`Development mode: bypassing reminder email delivery for ${recipientEmail} (example.com domain)`);
    return { devMode: true };
  }

  try {
    console.log(`Sending actual email via Resend.com to ${recipientEmail}...`);
    const emailSubject = subject || `WedFlow CRM - ${reminderType} Reminder`;
    const textContent = `WedFlow CRM - Reminder Notification\n\nReminder Type: ${reminderType.replace(/_/g, ' ').toUpperCase()}\nDays Before Event: ${daysBeforeEvent} day(s)\n\n${messageContent || 'This is an automated reminder from WedFlow CRM to keep you informed about your upcoming wedding event.'}\n\n---\nThis is an automated message from WedFlow CRM.\nFor support, please contact our team.`;
    
    const { data, error } = await resend.emails.send({
      from: 'WedFlow CRM <onboarding@resend.dev>',
      to: [recipientEmail],
      subject: emailSubject,
      text: textContent,
      html: `
        <!DOCTYPE html>
        <html>
        <head>
          <meta charset="utf-8">
          <meta name="viewport" content="width=device-width, initial-scale=1.0">
          <title>WedFlow CRM Reminder</title>
        </head>
        <body style="font-family: Arial, sans-serif; margin: 0; padding: 0; background-color: #f4f4f4;">
          <div style="max-width: 600px; margin: 0 auto; background-color: #ffffff; padding: 30px; border-radius: 8px; box-shadow: 0 2px 4px rgba(0,0,0,0.1);">
            <div style="text-align: center; margin-bottom: 30px;">
              <h1 style="color: #f5b719; margin: 0; font-size: 24px;">WedFlow CRM</h1>
              <p style="color: #666; margin: 5px 0 0; font-size: 14px;">Professional Wedding Event Management</p>
            </div>
            
            <div style="background-color: #fff9e6; border-left: 4px solid #f5b719; padding: 15px; margin: 20px 0; border-radius: 4px;">
              <h2 style="color: #333; margin: 0 0 10px; font-size: 18px;">⏰ Reminder Notification</h2>
              <p style="margin: 0; color: #666; font-size: 14px;">You have an upcoming event reminder</p>
            </div>
            
            <div style="margin: 20px 0;">
              <p style="margin: 10px 0; color: #333; font-size: 14px;"><strong>Reminder Type:</strong> ${reminderType.replace(/_/g, ' ').toUpperCase()}</p>
              <p style="margin: 10px 0; color: #333; font-size: 14px;"><strong>Days Before Event:</strong> ${daysBeforeEvent} day(s)</p>
            </div>
            
            <div style="background-color: #f8f9fa; padding: 20px; margin: 20px 0; border-radius: 8px; border: 1px solid #e9ecef;">
              <p style="margin: 0; color: #333; font-size: 14px; line-height: 1.6;">${messageContent || 'This is an automated reminder from WedFlow CRM to keep you informed about your upcoming wedding event.'}</p>
            </div>
            
            <div style="margin-top: 30px; padding-top: 20px; border-top: 1px solid #e9ecef;">
              <p style="margin: 0; color: #999; font-size: 12px; text-align: center;">
                This is an automated message from WedFlow CRM.<br>
                For support, please contact our team.
              </p>
            </div>
          </div>
        </body>
        </html>
      `,
    });

    if (error) {
      console.error('Resend error:', error);
      throw error;
    }

    console.log(`✅ Email successfully sent to ${recipientEmail}. Resend response:`, data);
    return data;
  } catch (error) {
    console.error('❌ Error sending reminder email:', error);
    throw error;
  }
}

function extractBearerToken(req) {
  const authHeader = req.headers.authorization || '';
  if (!authHeader.toLowerCase().startsWith('bearer ')) {
    return null;
  }

  return authHeader.slice(7).trim();
}

async function requireAuth(req, res, next) {
  const token = extractBearerToken(req);

  if (!token) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  try {
    const decoded = jwt.verify(token, process.env.JWT_SECRET);
    const userResult = await pool.query(
      `SELECT id, email, first_name, last_name, phone_number, role, staff_name, profile_image, workspace_id, is_active, is_verified
       FROM users WHERE id = $1 LIMIT 1`,
      [decoded.userId]
    );

    if (userResult.rows.length === 0) {
      return res.status(401).json({ error: 'User is not authorized' });
    }

    const user = userResult.rows[0];

    if (!user.is_active) {
      return res.status(403).json({ error: 'User account is inactive' });
    }

    if (decoded.workspace_id && user.workspace_id && decoded.workspace_id !== user.workspace_id) {
      return res.status(403).json({ error: 'Workspace mismatch detected' });
    }

    req.user = {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      phone_number: user.phone_number,
      role: user.role,
      staff_name: user.staff_name,
      profile_image: user.profile_image,
      workspace_id: user.workspace_id,
      is_active: user.is_active,
      is_verified: user.is_verified,
    };

    return next();
  } catch (error) {
    console.error('Authentication error:', error);
    return res.status(401).json({ error: 'Invalid or expired token' });
  }
}

async function requireWorkspaceAccess(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (!req.user.workspace_id) {
    return res.status(403).json({ error: 'No workspace access assigned' });
  }

  const userResult = await pool.query(
    'SELECT id, workspace_id, role FROM users WHERE id = $1 LIMIT 1',
    [req.user.id]
  );

  if (userResult.rows.length === 0) {
    return res.status(401).json({ error: 'User not found' });
  }

  const user = userResult.rows[0];
  if (!user.workspace_id) {
    return res.status(403).json({ error: 'Workspace access missing on user record' });
  }

  if (req.user.workspace_id !== user.workspace_id) {
    return res.status(403).json({ error: 'You do not have access to this workspace' });
  }

  req.user.role = user.role;
  req.user.workspace_id = user.workspace_id;
  return next();
}

function requireAdmin(req, res, next) {
  if (!req.user) {
    return res.status(401).json({ error: 'Authentication required' });
  }

  if (req.user.role !== 'admin') {
    return res.status(403).json({ error: 'Admin access required' });
  }

  return next();
}

async function verifyTurnstileToken(token) {
  try {
    const response = await fetch('https://challenges.cloudflare.com/turnstile/v0/siteverify', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/x-www-form-urlencoded',
      },
      body: `secret=${encodeURIComponent(process.env.TURNSTILE_SECRET_KEY)}&response=${encodeURIComponent(token)}`,
    });

    const result = await response.json();
    return result.success;
  } catch (error) {
    console.error('Error verifying Turnstile token:', error);
    // In development mode, allow the request to proceed even if Turnstile fails
    if (process.env.NODE_ENV !== 'production') {
      console.warn('Development mode: allowing request despite Turnstile verification failure');
      return true;
    }
    return false;
  }
}

async function createUserFromOtp({ email, firstName, lastName, phoneNumber, workspaceId }) {
  const normalizedEmail = normalizeEmail(email);

  if (!workspaceId) {
    throw new Error('workspace_id is required for user creation');
  }

  const result = await pool.query(
    `INSERT INTO users (email, first_name, last_name, phone_number, role, is_active, is_verified, workspace_id)
     VALUES ($1, $2, $3, $4, 'client', true, true, $5)
     RETURNING id, email, first_name, last_name, phone_number, role, staff_name, profile_image, workspace_id`,
    [
      normalizedEmail,
      firstName?.trim() || null,
      lastName?.trim() || null,
      phoneNumber?.trim() || null,
      workspaceId,
    ]
  );

  return result.rows[0];
}

app.get('/api/health', (req, res) => {
  res.json({ status: 'OK', message: 'WedFlow CRM Backend is running' });
});

app.post('/api/auth/demo-login', async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = normalizeEmail(email || 'admin@gmail.com');

  if (normalizedEmail !== 'admin@gmail.com') {
    return res.status(403).json({ error: 'Demo login is only available for admin@gmail.com' });
  }

  try {
    const userResult = await pool.query(
      'SELECT id, email, first_name, last_name, phone_number, role, staff_name, profile_image, workspace_id, is_active FROM users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );

    let user = userResult.rows[0];

    if (!user) {
      let workspaceId = null;
      const workspaceResult = await pool.query(
        'SELECT id FROM workspace ORDER BY id ASC LIMIT 1'
      );

      if (workspaceResult.rows.length > 0) {
        workspaceId = workspaceResult.rows[0].id;
      } else {
        const newWorkspace = await pool.query(
          `INSERT INTO workspace (company_name, notification_mode, status, created_at)
           VALUES ($1, 'email', 'active', NOW())
           RETURNING id`,
          ['Demo Workspace']
        );
        workspaceId = newWorkspace.rows[0].id;
      }

      user = await createUserFromOtp({
        email: normalizedEmail,
        firstName: 'Demo',
        lastName: 'Admin',
        phoneNumber: null,
        workspaceId,
      });

      await pool.query(
        'UPDATE users SET role = $1, is_active = true, is_verified = true WHERE id = $2',
        ['admin', user.id]
      );
      user.role = 'admin';
      user.is_active = true;
    }

    if (!user.is_active) {
      await pool.query('UPDATE users SET is_active = true WHERE id = $1', [user.id]);
      user.is_active = true;
    }

    if (!user.workspace_id) {
      const wsRes = await pool.query('SELECT id FROM workspace ORDER BY id ASC LIMIT 1');
      if (wsRes.rows.length > 0) {
        user.workspace_id = wsRes.rows[0].id;
        await pool.query('UPDATE users SET workspace_id = $1 WHERE id = $2', [user.workspace_id, user.id]);
      }
    }

    const token = generateToken(user.id, user.email, user.role || 'admin', user.workspace_id);

    return res.json({
      success: true,
      message: 'Demo login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name || 'Demo',
        lastName: user.last_name || 'Admin',
        phoneNumber: user.phone_number,
        role: user.role || 'admin',
        staffName: user.staff_name,
        profileImage: user.profile_image,
        workspace_id: user.workspace_id,
      },
    });
  } catch (error) {
    console.error('Error during demo login:', error);
    return res.status(500).json({ error: 'Demo login failed' });
  }
});

app.post('/api/auth/send-otp', async (req, res) => {
  const { email, turnstileToken } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Email is required' });
  }

  if (!turnstileToken) {
    return res.status(400).json({ error: 'Turnstile verification is required' });
  }

  const requestWindow = getRateLimitWindow(normalizedEmail, otpRequestTracker, OTP_RATE_LIMIT_MAX_REQUESTS, OTP_RATE_LIMIT_WINDOW_MS);
  if (requestWindow.blocked) {
    return res.status(429).json({ error: 'Too many OTP requests. Please wait a moment and try again.' });
  }

  const isValidTurnstile = await verifyTurnstileToken(turnstileToken);
  if (!isValidTurnstile) {
    return res.status(400).json({ error: 'Human verification failed' });
  }

  try {
    const otp = generateOTP(normalizedEmail);
    const otpHash = hashOTP(otp);
    const expiresAt = new Date(Date.now() + OTP_TTL_MINUTES * 60 * 1000);

    await pool.query('DELETE FROM otp_codes WHERE email = $1 AND is_used = false', [normalizedEmail]);
    await pool.query(
      'INSERT INTO otp_codes (email, otp_code, expires_at, is_used) VALUES ($1, $2, $3, false)',
      [normalizedEmail, otpHash, expiresAt]
    );

    const emailResult = await sendOTPEmail(normalizedEmail, otp);

    return res.json({
      success: true,
      message: 'OTP sent successfully',
      expiresAt: expiresAt.toISOString(),
      devOtp: emailResult?.devMode ? otp : undefined,
    });
  } catch (error) {
    console.error('Error sending OTP:', error);
    return res.status(500).json({ error: 'Failed to send OTP' });
  }
});

app.post('/api/auth/verify-otp', async (req, res) => {
  const { email, otp, firstName, lastName, phoneNumber } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail || !otp) {
    return res.status(400).json({ error: 'Email and OTP are required' });
  }

  if (String(otp).length !== 6 || !/^\d+$/.test(String(otp))) {
    return res.status(400).json({ error: 'Invalid OTP format' });
  }

  // Demo user bypass: admin@gmail.com with OTP 123456
  const isDemoUser = normalizedEmail === 'admin@gmail.com' && otp === '123456';

  if (!isDemoUser) {
    const attemptState = getVerifyAttemptState(normalizedEmail, otpVerifyTracker);
    if (attemptState.blocked) {
      return res.status(429).json({ error: 'Too many failed verification attempts. Please wait and request a new OTP.' });
    }
  }

  try {
    const userResult = await pool.query(
      'SELECT id, email, first_name, last_name, phone_number, role, staff_name, profile_image, workspace_id FROM users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );

    let isValidOtp = false;

    if (isDemoUser) {
      // Demo user: bypass OTP check
      isValidOtp = true;
    } else {
      const otpResult = await pool.query(
        'SELECT id, email, otp_code, expires_at, is_used FROM otp_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
        [normalizedEmail]
      );

      const otpRecord = otpResult.rows[0];
      const isExpired = !otpRecord || new Date(otpRecord.expires_at).getTime() < Date.now();
      isValidOtp = otpRecord && !otpRecord.is_used && !isExpired && otpRecord.otp_code === hashOTP(otp);
    }

    if (!isValidOtp) {
      const userId = userResult.rows[0]?.id || null;
      if (userId) {
        await logUserActivity({
          userId,
          action: 'failed_otp_verification',
          description: 'OTP verification failed or expired',
          req,
          workspaceId: userResult.rows[0]?.workspace_id,
        });
      }

      return res.status(401).json({ error: 'Invalid or expired OTP' });
    }

    let user = userResult.rows[0];
    const isNewUser = !user;

    if (isNewUser) {
      // For demo user, use default workspace_id or require it from request
      let workspaceId = req.body.workspaceId;

      // If demo user and no workspace provided, try to find or create a default workspace
      if (isDemoUser && !workspaceId) {
        const workspaceResult = await pool.query(
          'SELECT id FROM workspace WHERE company_name ILIKE $1 LIMIT 1',
          ['Demo Workspace']
        );

        if (workspaceResult.rows.length > 0) {
          workspaceId = workspaceResult.rows[0].id;
        } else {
          // Create default workspace for demo
          const newWorkspace = await pool.query(
            `INSERT INTO workspace (company_name, notification_mode, status, created_at)
             VALUES ($1, 'email', 'active', NOW())
             RETURNING id`,
            ['Demo Workspace']
          );
          workspaceId = newWorkspace.rows[0].id;
        }
      }

      if (!workspaceId) {
        return res.status(400).json({ error: 'workspace_id is required for new user registration' });
      }

      user = await createUserFromOtp({
        email: normalizedEmail,
        firstName: isDemoUser ? 'Demo' : firstName,
        lastName: isDemoUser ? 'Admin' : lastName,
        phoneNumber: isDemoUser ? null : phoneNumber,
        workspaceId
      });

      // Make demo user an admin
      if (isDemoUser) {
        await pool.query(
          'UPDATE users SET role = $1 WHERE id = $2',
          ['admin', user.id]
        );
        user.role = 'admin';
      }
    }

    if (!user.workspace_id) {
      return res.status(400).json({ error: 'User must be assigned to a workspace' });
    }

    // Only mark OTP as used if it's not a demo user
    if (!isDemoUser) {
      const otpResult = await pool.query(
        'SELECT id FROM otp_codes WHERE email = $1 ORDER BY created_at DESC LIMIT 1',
        [normalizedEmail]
      );
      if (otpResult.rows[0]) {
        await pool.query('UPDATE otp_codes SET is_used = true WHERE id = $1', [otpResult.rows[0].id]);
      }
    }

    const token = generateToken(user.id, user.email, user.role, user.workspace_id);

    await logUserActivity({
      userId: user.id,
      action: 'login',
      description: isDemoUser ? 'Demo user logged in' : (isNewUser ? 'New user signed in via OTP' : 'User signed in via OTP'),
      req,
      workspaceId: user.workspace_id,
    });

    return res.json({
      success: true,
      message: isNewUser ? 'Account created successfully' : 'Login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phoneNumber: user.phone_number,
        role: user.role,
        staffName: user.staff_name,
        profileImage: user.profile_image,
        workspace_id: user.workspace_id,
        isNewUser,
      },
    });
  } catch (error) {
    console.error('Error verifying OTP:', error);
    return res.status(500).json({ error: 'Failed to verify OTP' });
  }
});

// Demo login endpoint - bypass OTP for admin@gmail.com (must be before auth middleware)
app.post('/api/auth/demo-login', async (req, res) => {
  const { email } = req.body;
  const normalizedEmail = normalizeEmail(email);

  if (!normalizedEmail) {
    return res.status(400).json({ error: 'Email is required' });
  }

  // Only allow demo login for admin@gmail.com
  if (normalizedEmail !== 'admin@gmail.com') {
    return res.status(403).json({ error: 'Demo login is only available for admin@gmail.com' });
  }

  try {
    const userResult = await pool.query(
      'SELECT id, email, first_name, last_name, phone_number, role, staff_name, profile_image, workspace_id FROM users WHERE email = $1 LIMIT 1',
      [normalizedEmail]
    );

    let user = userResult.rows[0];
    const isNewUser = !user;

    if (isNewUser) {
      // Create or find default workspace for demo
      let workspaceId;
      const workspaceResult = await pool.query(
        'SELECT id FROM workspace WHERE company_name ILIKE $1 LIMIT 1',
        ['Demo Workspace']
      );

      if (workspaceResult.rows.length > 0) {
        workspaceId = workspaceResult.rows[0].id;
      } else {
        // Create default workspace for demo
        const newWorkspace = await pool.query(
          `INSERT INTO workspace (company_name, notification_mode, status, created_at)
           VALUES ($1, 'email', 'active', NOW())
           RETURNING id`,
          ['Demo Workspace']
        );
        workspaceId = newWorkspace.rows[0].id;
      }

      user = await createUserFromOtp({
        email: normalizedEmail,
        firstName: 'Demo',
        lastName: 'Admin',
        phoneNumber: null,
        workspaceId
      });

      // Make demo user an admin
      await pool.query(
        'UPDATE users SET role = $1 WHERE id = $2',
        ['admin', user.id]
      );
      user.role = 'admin';
    }

    if (!user.workspace_id) {
      return res.status(400).json({ error: 'User must be assigned to a workspace' });
    }

    const token = generateToken(user.id, user.email, user.role, user.workspace_id);

    await logUserActivity({
      userId: user.id,
      action: 'demo_login',
      description: 'Demo user logged in without OTP',
      req,
      workspaceId: user.workspace_id,
    });

    return res.json({
      success: true,
      message: isNewUser ? 'Demo account created successfully' : 'Demo login successful',
      token,
      user: {
        id: user.id,
        email: user.email,
        firstName: user.first_name,
        lastName: user.last_name,
        phoneNumber: user.phone_number,
        role: user.role,
        staffName: user.staff_name,
        profileImage: user.profile_image,
        workspace_id: user.workspace_id,
        isNewUser,
      },
    });
  } catch (error) {
    console.error('Error with demo login:', error);
    return res.status(500).json({ error: 'Failed to complete demo login' });
  }
});

app.use('/api', requireAuth);
app.use('/api', requireWorkspaceAccess);

// Storage Routes (R2 only — Cloudflare)
app.use('/api/storage', require('./routes/storageRoutes'));
app.use('/api/photo-selections', require('./routes/photoSelectionRoutes'));

// Backup Routes (AWS Glacier Deep Archive — Step 6)
app.use('/api/backup', require('./routes/backupRoutes'));

// GET /api/workspace/settings - Get workspace settings
app.get('/api/workspace/settings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, company_name, notification_mode, logo_url, crew_assignment_days, 
              whatsapp_enabled, email_formats_count, timezone, currency, status
       FROM workspace 
       WHERE id = $1 LIMIT 1`,
      [req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const workspace = result.rows[0];
    return res.json({
      id: workspace.id,
      companyName: workspace.company_name,
      notificationMode: workspace.notification_mode,
      logoUrl: workspace.logo_url,
      crewAssignmentDays: workspace.crew_assignment_days,
      whatsappEnabled: workspace.whatsapp_enabled,
      emailFormatsCount: workspace.email_formats_count,
      timezone: workspace.timezone,
      currency: workspace.currency,
      status: workspace.status
    });
  } catch (error) {
    console.error('Error fetching workspace settings:', error);
    return res.status(500).json({ error: 'Failed to fetch workspace settings' });
  }
});

// PUT /api/workspace/settings - Update workspace settings
app.put('/api/workspace/settings', async (req, res) => {
  try {
    const { logoUrl, crewAssignmentDays, notificationMode } = req.body;
    
    const updates = [];
    const values = [];
    let paramCount = 1;

    if (logoUrl !== undefined) {
      updates.push(`logo_url = $${paramCount++}`);
      values.push(logoUrl);
    }

    if (crewAssignmentDays !== undefined) {
      updates.push(`crew_assignment_days = $${paramCount++}`);
      values.push(crewAssignmentDays);
    }

    if (notificationMode !== undefined) {
      updates.push(`notification_mode = $${paramCount++}`);
      values.push(notificationMode);
    }

    if (updates.length === 0) {
      return res.status(400).json({ error: 'No valid fields to update' });
    }

    values.push(req.user.workspace_id);

    const result = await pool.query(
      `UPDATE workspace 
       SET ${updates.join(', ')}, updated_at = NOW()
       WHERE id = $${paramCount}
       RETURNING id, company_name, notification_mode, logo_url, crew_assignment_days, 
                 whatsapp_enabled, email_formats_count, timezone, currency, status`,
      values
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Workspace not found' });
    }

    const workspace = result.rows[0];
    return res.json({
      id: workspace.id,
      companyName: workspace.company_name,
      notificationMode: workspace.notification_mode,
      logoUrl: workspace.logo_url,
      crewAssignmentDays: workspace.crew_assignment_days,
      whatsappEnabled: workspace.whatsapp_enabled,
      emailFormatsCount: workspace.email_formats_count,
      timezone: workspace.timezone,
      currency: workspace.currency,
      status: workspace.status
    });
  } catch (error) {
    console.error('Error updating workspace settings:', error);
    return res.status(500).json({ error: 'Failed to update workspace settings' });
  }
});

app.post('/api/users', requireAdmin, async (req, res) => {
  const { email: rawEmail, firstName, lastName, phoneNumber, role, staffName, address } = req.body;

  if (!rawEmail || !firstName) {
    return res.status(400).json({ error: 'Email and first name are required' });
  }

  const email = normalizeEmail(rawEmail);
  const userRole = role || 'client';

  try {
    const result = await pool.query(
      `INSERT INTO users (email, first_name, last_name, phone_number, role, staff_name, is_active, is_verified, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6, true, false, $7)
       RETURNING id, email, first_name, last_name, phone_number, role, staff_name, is_active, is_verified, created_at, workspace_id`,
      [email, firstName.trim(), lastName?.trim() || null, phoneNumber?.trim() || null, userRole, staffName?.trim() || null, req.user.workspace_id]
    );

    await logUserActivity({
      userId: req.user.id,
      action: 'user_created',
      description: `Created user ${email} with role ${userRole}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.status(201).json({ success: true, user: result.rows[0] });
  } catch (error) {
    if (error.code === '23505') {
      // Check if it's email+role duplicate (which is expected and allowed for different roles)
      if (error.constraint === 'users_email_role_unique') {
        return res.status(409).json({ error: 'A user with this email and role already exists' });
      }
      // Fallback for other unique constraint violations
      return res.status(409).json({ error: 'A user with this email already exists' });
    }
    console.error('Error creating user:', error);
    return res.status(500).json({ error: 'Failed to create user' });
  }
});

// GET /api/users - List all users in workspace
app.get('/api/users', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone_number, role, staff_name, is_active, is_verified, profile_image, created_at, updated_at
       FROM users
       WHERE workspace_id = $1
       ORDER BY role, created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({
      success: true,
      users: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching users:', error);
    return res.status(500).json({ error: 'Failed to fetch users' });
  }
});

// GET /api/users/:id - Get a single user by id
app.get('/api/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone_number, role, staff_name, is_active, is_verified, profile_image, created_at, updated_at
       FROM users
       WHERE id = $1 AND workspace_id = $2`,
      [id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    return res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching user details:', error);
    return res.status(500).json({ error: 'Failed to fetch user details' });
  }
});

// GET /api/staff-members - List staff members (non-client users) for crew assignment
app.get('/api/staff-members', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, email, first_name, last_name, phone_number, role, staff_name, is_active, is_verified, profile_image, created_at, updated_at
       FROM users
       WHERE workspace_id = $1 AND role != 'client' AND role != 'admin'
       ORDER BY role, created_at DESC`,
      [req.user.workspace_id]
    );

    console.log('Staff members fetched:', result.rows.length, 'users');
    result.rows.forEach(user => {
      console.log(`- ${user.staff_name || user.first_name} (${user.role}) - Active: ${user.is_active}`);
    });

    return res.json({
      success: true,
      users: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching staff members:', error);
    return res.status(500).json({ error: 'Failed to fetch staff members' });
  }
});

// PUT /api/users/:id - Update user
app.put('/api/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { firstName, lastName, phoneNumber, role, staffName, is_active } = req.body;

  try {
    const result = await pool.query(
      `UPDATE users
       SET first_name = $1, last_name = $2, phone_number = $3, role = $4, staff_name = $5, is_active = $6, updated_at = NOW()
       WHERE id = $7 AND workspace_id = $8
       RETURNING id, email, first_name, last_name, phone_number, role, staff_name, is_active, is_verified, created_at, updated_at`,
      [
        firstName?.trim() || null,
        lastName?.trim() || null,
        phoneNumber?.trim() || null,
        role || 'client',
        staffName?.trim() || null,
        is_active !== undefined ? is_active : true,
        id,
        req.user.workspace_id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'user_updated',
      description: `Updated user ${id}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({
      success: true,
      user: result.rows[0]
    });
  } catch (error) {
    console.error('Error updating user:', error);
    return res.status(500).json({ error: 'Failed to update user' });
  }
});

// DELETE /api/users/:id - Delete user
app.delete('/api/users/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM users
       WHERE id = $1 AND workspace_id = $2
       RETURNING email, first_name, last_name`,
      [id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'User not found' });
    }

    const deletedUser = result.rows[0];
    await logUserActivity({
      userId: req.user.id,
      action: 'user_deleted',
      description: `Deleted user ${deletedUser.email}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({
      success: true,
      message: 'User deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting user:', error);
    return res.status(500).json({ error: 'Failed to delete user' });
  }
});

app.get('/api/user/profile', async (req, res) => {
  const userResult = await pool.query(
    `SELECT id, email, first_name, last_name, phone_number, role, staff_name, profile_image, workspace_id
     FROM users WHERE id = $1 LIMIT 1`,
    [req.user.id]
  );

  if (userResult.rows.length === 0) {
    return res.status(404).json({ error: 'User not found' });
  }

  const user = userResult.rows[0];
  return res.json({
    user: {
      id: user.id,
      email: user.email,
      first_name: user.first_name,
      last_name: user.last_name,
      phone_number: user.phone_number,
      role: user.role,
      staff_name: user.staff_name,
      profile_image: user.profile_image,
      workspace_id: user.workspace_id,
    },
  });
});

// ============================================
// CLIENT CRUD API - Workspace Isolated
// ============================================

// GET /api/clients - List all clients in user's workspace
app.get('/api/clients', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT id, name, phone, email, address, status, created_at, updated_at
       FROM client
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({
      success: true,
      clients: result.rows,
      count: result.rows.length
    });
  } catch (error) {
    console.error('Error fetching clients:', error);
    return res.status(500).json({ error: 'Failed to fetch clients' });
  }
});

// POST /api/clients - Create new client in user's workspace
app.post('/api/clients', async (req, res) => {
  const { name, phone, email, address, status } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  // Check for duplicate phone number in workspace
  if (phone && phone.trim()) {
    const existingPhone = await pool.query(
      'SELECT id FROM client WHERE phone = $1 AND workspace_id = $2 LIMIT 1',
      [phone.trim(), req.user.workspace_id]
    );
    if (existingPhone.rows.length > 0) {
      return res.status(409).json({ error: 'A client with this phone number already exists' });
    }
  }

  // Check for duplicate email in workspace
  if (email && email.trim()) {
    const existingEmail = await pool.query(
      'SELECT id FROM client WHERE email = $1 AND workspace_id = $2 LIMIT 1',
      [email.trim(), req.user.workspace_id]
    );
    if (existingEmail.rows.length > 0) {
      return res.status(409).json({ error: 'A client with this email already exists' });
    }
  }

  try {
    const result = await pool.query(
      `INSERT INTO client (name, phone, email, address, status, workspace_id)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING id, name, phone, email, address, status, created_at, updated_at`,
      [
        name.trim(),
        phone?.trim() || null,
        email?.trim() || null,
        address?.trim() || null,
        status || 'active',
        req.user.workspace_id
      ]
    );

    await logUserActivity({
      userId: req.user.id,
      action: 'client_created',
      description: `Created client: ${name}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.status(201).json({
      success: true,
      client: result.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A client with this email or phone number already exists' });
    }
    console.error('Error creating client:', error);
    return res.status(500).json({ error: 'Failed to create client' });
  }
});

// GET /api/clients/:id - Get specific client in user's workspace
app.get('/api/clients/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `SELECT id, name, phone, email, address, status, created_at, updated_at
       FROM client
       WHERE id = $1 AND workspace_id = $2`,
      [id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    return res.json({
      success: true,
      client: result.rows[0]
    });
  } catch (error) {
    console.error('Error fetching client:', error);
    return res.status(500).json({ error: 'Failed to fetch client' });
  }
});

// PUT /api/clients/:id - Update client in user's workspace
app.put('/api/clients/:id', async (req, res) => {
  const { id } = req.params;
  const { name, phone, email, address, status } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Name is required' });
  }

  // Check for duplicate phone number in workspace (excluding current client)
  if (phone && phone.trim()) {
    const existingPhone = await pool.query(
      'SELECT id FROM client WHERE phone = $1 AND workspace_id = $2 AND id != $3 LIMIT 1',
      [phone.trim(), req.user.workspace_id, id]
    );
    if (existingPhone.rows.length > 0) {
      return res.status(409).json({ error: 'A client with this phone number already exists' });
    }
  }

  // Check for duplicate email in workspace (excluding current client)
  if (email && email.trim()) {
    const existingEmail = await pool.query(
      'SELECT id FROM client WHERE email = $1 AND workspace_id = $2 AND id != $3 LIMIT 1',
      [email.trim(), req.user.workspace_id, id]
    );
    if (existingEmail.rows.length > 0) {
      return res.status(409).json({ error: 'A client with this email already exists' });
    }
  }

  try {
    const result = await pool.query(
      `UPDATE client
       SET name = $1, phone = $2, email = $3, address = $4, status = $5, updated_at = NOW()
       WHERE id = $6 AND workspace_id = $7
       RETURNING id, name, phone, email, address, status, created_at, updated_at`,
      [
        name.trim(),
        phone?.trim() || null,
        email?.trim() || null,
        address?.trim() || null,
        status || 'active',
        id,
        req.user.workspace_id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'client_updated',
      description: `Updated client: ${name}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({
      success: true,
      client: result.rows[0]
    });
  } catch (error) {
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A client with this email or phone number already exists' });
    }
    console.error('Error updating client:', error);
    return res.status(500).json({ error: 'Failed to update client' });
  }
});

// DELETE /api/clients/:id - Delete client in user's workspace
app.delete('/api/clients/:id', async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM client
       WHERE id = $1 AND workspace_id = $2
       RETURNING name`,
      [id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Client not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'client_deleted',
      description: `Deleted client: ${result.rows[0].name}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({
      success: true,
      message: 'Client deleted successfully'
    });
  } catch (error) {
    console.error('Error deleting client:', error);
    return res.status(500).json({ error: 'Failed to delete client' });
  }
});

// ============================================
// LEADS API
// ============================================

// GET /api/leads - List all leads in workspace
app.get('/api/leads', async (req, res) => {
  try {
    const { status, priority, source } = req.query;
    let query = `
      SELECT l.*,
             COALESCE(u.staff_name, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), 'Unassigned') AS assigned_to_name
      FROM leads l
      LEFT JOIN users u ON u.id = l.assigned_to
      WHERE l.workspace_id = $1
    `;
    const params = [req.user.workspace_id];
    let paramCount = 1;

    if (status) {
      paramCount++;
      query += ` AND l.status = $${paramCount}`;
      params.push(status);
    }

    if (priority) {
      paramCount++;
      query += ` AND l.priority = $${paramCount}`;
      params.push(priority);
    }

    if (source) {
      paramCount++;
      query += ` AND l.source = $${paramCount}`;
      params.push(source);
    }

    query += ` ORDER BY l.created_at DESC`;

    const result = await pool.query(query, params);
    return res.json({ success: true, leads: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching leads:', error);
    return res.status(500).json({ error: 'Failed to fetch leads' });
  }
});

// POST /api/leads - Create new lead
app.post('/api/leads', async (req, res) => {
  const { name, phone, email, event_date, event_type, venue, estimated_budget, source, status, priority, notes, assigned_to } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Lead name is required' });
  }

  try {
    if (assigned_to) {
      const userCheck = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND workspace_id = $2`,
        [assigned_to, req.user.workspace_id]
      );
      if (userCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Assigned user not found in this workspace' });
      }
    }

    const result = await pool.query(
      `INSERT INTO leads (workspace_id, name, phone, email, event_date, event_type, venue, estimated_budget, source, status, priority, notes, assigned_to)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13)
       RETURNING *`,
      [req.user.workspace_id, String(name).trim(), phone?.trim() || null, email?.trim() || null, event_date || null, event_type?.trim() || null, venue?.trim() || null, estimated_budget !== undefined ? Number(estimated_budget) : null, source || 'direct', status || 'new', priority || 'medium', notes?.trim() || null, assigned_to || null]
    );

    const insertedLead = result.rows[0];
    const fullLead = await pool.query(
      `SELECT l.*,
              COALESCE(u.staff_name, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), 'Unassigned') AS assigned_to_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.id = $1`,
      [insertedLead.id]
    );

    return res.status(201).json({ success: true, lead: fullLead.rows[0] });
  } catch (error) {
    console.error('Error creating lead:', error);
    return res.status(500).json({ error: 'Failed to create lead' });
  }
});

// GET /api/leads/:id - Get specific lead
app.get('/api/leads/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT l.*,
              COALESCE(u.staff_name, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), 'Unassigned') AS assigned_to_name,
              c.name AS converted_client_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       LEFT JOIN client c ON c.id = l.converted_to_client_id
       WHERE l.id = $1 AND l.workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    return res.json({ success: true, lead: result.rows[0] });
  } catch (error) {
    console.error('Error fetching lead:', error);
    return res.status(500).json({ error: 'Failed to fetch lead' });
  }
});

// PUT /api/leads/:id - Update lead
app.put('/api/leads/:id', async (req, res) => {
  const { name, phone, email, event_date, event_type, venue, estimated_budget, source, status, priority, notes, assigned_to, converted_to_client_id } = req.body;

  try {
    if (assigned_to) {
      const userCheck = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND workspace_id = $2`,
        [assigned_to, req.user.workspace_id]
      );
      if (userCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Assigned user not found in this workspace' });
      }
    }

    if (converted_to_client_id) {
      const clientCheck = await pool.query(
        `SELECT id FROM client WHERE id = $1 AND workspace_id = $2`,
        [converted_to_client_id, req.user.workspace_id]
      );
      if (clientCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Client not found in this workspace' });
      }
    }

    const result = await pool.query(
      `UPDATE leads
       SET name = COALESCE($1, name),
           phone = $2,
           email = $3,
           event_date = $4,
           event_type = $5,
           venue = $6,
           estimated_budget = $7,
           source = COALESCE($8, source),
           status = COALESCE($9, status),
           priority = COALESCE($10, priority),
           notes = $11,
           assigned_to = $12,
           converted_to_client_id = $13,
           converted_at = CASE WHEN $13 IS NOT NULL AND converted_to_client_id IS NULL THEN NOW() ELSE converted_at END,
           updated_at = NOW()
       WHERE id = $14 AND workspace_id = $15
       RETURNING *`,
      [name?.trim() || null, phone?.trim() || null, email?.trim() || null, event_date || null, event_type?.trim() || null, venue?.trim() || null, estimated_budget !== undefined ? Number(estimated_budget) : null, source || null, status || null, priority || null, notes?.trim() || null, assigned_to || null, converted_to_client_id || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const fullLead = await pool.query(
      `SELECT l.*,
              COALESCE(u.staff_name, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), 'Unassigned') AS assigned_to_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       WHERE l.id = $1`,
      [req.params.id]
    );

    return res.json({ success: true, lead: fullLead.rows[0] });
  } catch (error) {
    console.error('Error updating lead:', error);
    return res.status(500).json({ error: 'Failed to update lead' });
  }
});

// DELETE /api/leads/:id - Delete lead
app.delete('/api/leads/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM leads WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    return res.json({ success: true, message: 'Lead deleted successfully' });
  } catch (error) {
    console.error('Error deleting lead:', error);
    return res.status(500).json({ error: 'Failed to delete lead' });
  }
});

// GET /api/leads/:id/activities - Get lead activities
app.get('/api/leads/:id/activities', async (req, res) => {
  try {
    const leadCheck = await pool.query(
      `SELECT id FROM leads WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (leadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const result = await pool.query(
      `SELECT la.*,
              COALESCE(u.staff_name, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), 'System') AS created_by_name
       FROM lead_activities la
       LEFT JOIN users u ON u.id = la.created_by
       WHERE la.lead_id = $1
       ORDER BY la.created_at DESC`,
      [req.params.id]
    );

    return res.json({ success: true, activities: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching lead activities:', error);
    return res.status(500).json({ error: 'Failed to fetch lead activities' });
  }
});

// POST /api/leads/:id/activities - Add lead activity
app.post('/api/leads/:id/activities', async (req, res) => {
  const { activity_type, description, outcome, next_follow_up_date } = req.body;

  if (!activity_type) {
    return res.status(400).json({ error: 'Activity type is required' });
  }

  try {
    const leadCheck = await pool.query(
      `SELECT id FROM leads WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (leadCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const result = await pool.query(
      `INSERT INTO lead_activities (lead_id, activity_type, description, outcome, next_follow_up_date, created_by)
       VALUES ($1, $2, $3, $4, $5, $6)
       RETURNING *`,
      [req.params.id, activity_type, description?.trim() || null, outcome?.trim() || null, next_follow_up_date || null, req.user.userId]
    );

    return res.status(201).json({ success: true, activity: result.rows[0] });
  } catch (error) {
    console.error('Error creating lead activity:', error);
    return res.status(500).json({ error: 'Failed to create lead activity' });
  }
});

// POST /api/leads/:id/convert - Convert a lead into a Client and Booking
app.post('/api/leads/:id/convert', async (req, res) => {
  const leadId = req.params.id;
  const workspaceId = req.user.workspace_id;

  try {
    // 1. Fetch Lead
    const leadResult = await pool.query(
      `SELECT * FROM leads WHERE id = $1 AND workspace_id = $2`,
      [leadId, workspaceId]
    );

    if (leadResult.rows.length === 0) {
      return res.status(404).json({ error: 'Lead not found' });
    }

    const lead = leadResult.rows[0];

    // Check if already converted
    if (lead.converted_to_client_id) {
      return res.status(400).json({ error: 'Lead has already been converted to a client' });
    }

    // 2. Create Client
    const clientResult = await pool.query(
      `INSERT INTO client (workspace_id, name, phone, email, notes, status)
       VALUES ($1, $2, $3, $4, $5, 'active')
       RETURNING *`,
      [
        workspaceId,
        lead.name.trim(),
        lead.phone?.trim() || null,
        lead.email?.trim() || null,
        `Converted from Lead ID: DRVSTU-LED-${lead.id.slice(0, 8).toUpperCase()}`
      ]
    );
    const client = clientResult.rows[0];

    // 3. Find or Create Package
    let packageId = (await pool.query(
      `SELECT id FROM packages WHERE workspace_id = $1 ORDER BY created_at ASC LIMIT 1`,
      [workspaceId]
    )).rows[0]?.id;

    if (!packageId) {
      const pkgResult = await pool.query(
        `INSERT INTO packages (workspace_id, name, total_price)
         VALUES ($1, 'Custom Wedding Package', $2)
         RETURNING id`,
        [workspaceId, lead.estimated_budget || 0]
      );
      packageId = pkgResult.rows[0].id;
    }

    // 4. Generate Booking Number
    const bkgNumResult = await pool.query(
      `SELECT 'DRVSTU-BKG-' || LPAD((COUNT(*) + 1)::text, 6, '0') AS booking_number
       FROM bookings WHERE workspace_id = $1`,
      [workspaceId]
    );
    const bookingNumber = bkgNumResult.rows[0].booking_number;

    // 5. Create Booking
    const bookingResult = await pool.query(
      `INSERT INTO bookings (workspace_id, client_id, package_id, booking_number, booking_date, total_amount, status, current_workflow_stage, notes)
       VALUES ($1, $2, $3, $4, CURRENT_DATE, $5, 'confirmed', 'booking', $6)
       RETURNING *`,
      [
        workspaceId,
        client.id,
        packageId,
        bookingNumber,
        lead.estimated_budget || 0,
        lead.notes || `Converted from Lead ${lead.name}`
      ]
    );
    const booking = bookingResult.rows[0];

    // 6. Create Booking Event if date/venue/eventType exists
    if (lead.event_date || lead.venue || lead.event_type) {
      let eventTypeId = (await pool.query(
        `SELECT id FROM event_type WHERE workspace_id = $1 LIMIT 1`,
        [workspaceId]
      )).rows[0]?.id;

      if (!eventTypeId) {
        const etResult = await pool.query(
          `INSERT INTO event_type (workspace_id, name) VALUES ($1, 'Wedding') RETURNING id`,
          [workspaceId]
        );
        eventTypeId = etResult.rows[0].id;
      }

      await pool.query(
        `INSERT INTO booking_events (workspace_id, booking_id, event_type_id, event_name, event_date, venue, notes)
         VALUES ($1, $2, $3, $4, $5::date, $6, $7)`,
        [
          workspaceId,
          booking.id,
          eventTypeId,
          lead.event_type || 'Wedding Event',
          lead.event_date || '2099-12-31',
          lead.venue || null,
          lead.notes || null
        ]
      );
    }

    // 7. Update Lead
    const updatedLeadResult = await pool.query(
      `UPDATE leads
       SET status = 'won',
           converted_to_client_id = $1,
           converted_at = NOW(),
           updated_at = NOW()
       WHERE id = $2 AND workspace_id = $3
       RETURNING *`,
      [client.id, leadId, workspaceId]
    );

    // Fetch full lead with assigned_to_name & converted_client_name
    const fullLeadResult = await pool.query(
      `SELECT l.*,
              COALESCE(u.staff_name, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), 'Unassigned') AS assigned_to_name,
              c.name AS converted_client_name
       FROM leads l
       LEFT JOIN users u ON u.id = l.assigned_to
       LEFT JOIN client c ON c.id = l.converted_to_client_id
       WHERE l.id = $1 AND l.workspace_id = $2`,
      [leadId, workspaceId]
    );

    return res.status(200).json({
      success: true,
      message: `Successfully converted lead ${lead.name} to Client & Booking (${bookingNumber})`,
      client,
      booking,
      lead: fullLeadResult.rows[0]
    });
  } catch (error) {
    console.error('Error converting lead to client & booking:', error);
    return res.status(500).json({ error: 'Failed to convert lead to client & booking' });
  }
});

// GET /api/packages - List packages in the authenticated user's workspace
app.get('/api/packages', async (req, res) => {
  try {
    const result = await pool.query(
            `SELECT id, name, duration_days, status, price, description,
              reminder_day, reminder_email_days, created_at, updated_at,
              COALESCE((SELECT json_agg(d.item_name ORDER BY d.display_order, d.created_at)
            FROM deliverables d WHERE d.package_id = packages.id), '[]'::json) AS deliverables
       FROM packages
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [req.user.workspace_id]
    );
    return res.json({ success: true, packages: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching packages:', error);
    return res.status(500).json({ error: 'Failed to fetch packages' });
  }
});

// POST /api/packages - Create a package for the authenticated user's workspace
app.post('/api/packages', requireAdmin, async (req, res) => {
  const { name, durationDays, price, description, status, reminderDay, reminderEmailDays, deliverables } = req.body;

  if (!name || !durationDays || price === undefined) {
    return res.status(400).json({ error: 'Name, duration days, and price are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO packages (workspace_id, name, duration_days, status, price, description, reminder_day, reminder_email_days)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING id, name, duration_days, status, price, description, reminder_day, reminder_email_days, created_at, updated_at`,
      [req.user.workspace_id, name.trim(), Number(durationDays), status || 'active', Number(price),
        description?.trim() || null, reminderDay || null, reminderEmailDays || 7]
    );
    const packageRow = result.rows[0];
    const items = Array.isArray(deliverables) ? deliverables.map(item => String(item).trim()).filter(Boolean) : [];
    if (items.length > 0) {
      await pool.query(
        `INSERT INTO deliverables (workspace_id, package_id, item_name, display_order)
         SELECT $1, $2, item_name, ordinal - 1
         FROM unnest($3::text[]) WITH ORDINALITY AS values(item_name, ordinal)`,
        [req.user.workspace_id, packageRow.id, items]
      );
    }
    packageRow.deliverables = items;
    return res.status(201).json({ success: true, package: packageRow });
  } catch (error) {
    console.error('Error creating package:', error);
    if (error.code === '23505') return res.status(409).json({ error: 'A package with this name already exists' });
    return res.status(500).json({ error: 'Failed to create package' });
  }
});

// PUT /api/packages/:id - Update a package
app.put('/api/packages/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;
  const { name, durationDays, price, description, status, reminderDay, reminderEmailDays, deliverables } = req.body;

  try {
    const result = await pool.query(
      `UPDATE packages
       SET name = COALESCE($1, name),
           duration_days = COALESCE($2, duration_days),
           status = COALESCE($3, status),
           price = COALESCE($4, price),
           description = $5,
           reminder_day = COALESCE($6, reminder_day),
           reminder_email_days = COALESCE($7, reminder_email_days),
           updated_at = NOW()
       WHERE id = $8 AND workspace_id = $9
       RETURNING id, name, duration_days, status, price, description, reminder_day, reminder_email_days, created_at, updated_at`,
      [
        name?.trim() || null,
        durationDays !== undefined ? Number(durationDays) : null,
        status || null,
        price !== undefined ? Number(price) : null,
        description?.trim() || null,
        reminderDay !== undefined ? Number(reminderDay) : null,
        reminderEmailDays !== undefined ? Number(reminderEmailDays) : null,
        id,
        req.user.workspace_id
      ]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    if (Array.isArray(deliverables)) {
      await pool.query('DELETE FROM deliverables WHERE package_id = $1', [id]);
      const items = deliverables.map(item => String(item).trim()).filter(Boolean);
      if (items.length > 0) {
        await pool.query(
          `INSERT INTO deliverables (workspace_id, package_id, item_name, display_order)
           SELECT $1, $2, item_name, ordinal - 1
           FROM unnest($3::text[]) WITH ORDINALITY AS values(item_name, ordinal)`,
          [req.user.workspace_id, id, items]
        );
      }
      result.rows[0].deliverables = items;
    }

    return res.json({ success: true, package: result.rows[0] });
  } catch (error) {
    console.error('Error updating package:', error);
    if (error.code === '23505') return res.status(409).json({ error: 'A package with this name already exists' });
    return res.status(500).json({ error: 'Failed to update package' });
  }
});

// DELETE /api/packages/:id - Delete a package
app.delete('/api/packages/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    const result = await pool.query(
      `DELETE FROM packages
       WHERE id = $1 AND workspace_id = $2
       RETURNING name`,
      [id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Package not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'package_deleted',
      description: `Deleted package ${result.rows[0].name}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, message: 'Package deleted successfully' });
  } catch (error) {
    console.error('Error deleting package:', error);
    return res.status(500).json({ error: 'Failed to delete package' });
  }
});

// GET /api/bookings - List bookings with workspace-scoped client and package names
app.get('/api/bookings', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT b.id, b.booking_number, b.booking_date, b.total_amount, b.status,
              b.current_workflow_stage, b.notes, b.created_at, b.updated_at,
              c.id AS client_id, c.name AS client_name,
              p.id AS package_id, p.name AS package_name,
              be.event_date, be.venue,
              COALESCE((SELECT json_agg(json_build_object(
                'id', e.id, 'event_name', e.event_name, 'event_date', e.event_date, 'venue', e.venue)
                ORDER BY e.event_date)
                FROM booking_events e WHERE e.booking_id = b.id AND e.workspace_id = b.workspace_id), '[]') AS event_days,
              COALESCE((SELECT json_agg(json_build_object(
                'day_number', pd.day_number, 'event_type', pd.event_type,
                'roles', COALESCE((SELECT json_agg(json_build_object('role', ct.name, 'quantity', pdc.quantity))
                      FROM package_day_crew pdc JOIN crew_types ct ON ct.id = pdc.crew_type_id
                      WHERE pdc.package_day_id = pd.id), '[]'))
                ORDER BY pd.day_number)
                FROM package_days pd WHERE pd.package_id = p.id AND pd.workspace_id = p.workspace_id), '[]') AS package_crew_plan
       FROM bookings b
       JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       JOIN packages p ON p.id = b.package_id AND p.workspace_id = b.workspace_id
       LEFT JOIN LATERAL (
         SELECT event_date, venue FROM booking_events
         WHERE booking_id = b.id ORDER BY event_date ASC LIMIT 1
       ) be ON true
       WHERE b.workspace_id = $1
       ORDER BY b.booking_date DESC, b.created_at DESC`,
      [req.user.workspace_id]
    );
    return res.json({ success: true, bookings: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching bookings:', error);
    return res.status(500).json({ error: 'Failed to fetch bookings' });
  }
});

// POST /api/bookings - Create a booking linked to an existing client and package
app.post('/api/bookings', requireAdmin, async (req, res) => {
  const { clientId, packageId, bookingDate, eventDate, totalAmount, venue, eventType, status, currentWorkflowStage, notes } = req.body;

  if (!clientId || !packageId || !bookingDate || !eventDate || !venue || totalAmount === undefined) {
    return res.status(400).json({ error: 'Client, package, booking date, event date, venue, and amount are required' });
  }

  try {
    const ownership = await pool.query(
      `SELECT c.id AS client_id, p.id AS package_id
       FROM client c CROSS JOIN packages p
       WHERE c.id = $1 AND p.id = $2 AND c.workspace_id = $3 AND p.workspace_id = $3`,
      [clientId, packageId, req.user.workspace_id]
    );
    if (ownership.rows.length === 0) {
      return res.status(400).json({ error: 'Client or package is not available in this workspace' });
    }

    const numberResult = await pool.query(
      `SELECT 'DRVSTU-BKG-' || LPAD((COUNT(*) + 1)::text, 6, '0') AS booking_number
       FROM bookings WHERE workspace_id = $1`,
      [req.user.workspace_id]
    );
    const result = await pool.query(
      `INSERT INTO bookings (workspace_id, client_id, package_id, booking_number, booking_date,
                             total_amount, status, current_workflow_stage, notes)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7, $8, $9)
       RETURNING id`,
      [req.user.workspace_id, clientId, packageId, numberResult.rows[0].booking_number, bookingDate,
        Number(totalAmount), status || 'draft', currentWorkflowStage || 'booking', notes || null]
    );

    let eventTypeId = (await pool.query(
      `SELECT id FROM event_type WHERE workspace_id = $1 AND is_active = true
       AND LOWER(name) = LOWER($2) LIMIT 1`,
      [req.user.workspace_id, eventType || 'Other']
    )).rows[0]?.id;
    if (!eventTypeId) {
      eventTypeId = (await pool.query(
        `INSERT INTO event_type (workspace_id, name) VALUES ($1, $2)
         ON CONFLICT (workspace_id, name) DO UPDATE SET is_active = true RETURNING id`,
        [req.user.workspace_id, eventType || 'Other']
      )).rows[0]?.id;
    }

    await pool.query(
      `INSERT INTO booking_events (workspace_id, booking_id, event_type_id, event_name, event_date, venue, notes)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7)`,
      [req.user.workspace_id, result.rows[0].id, eventTypeId, eventType || 'Other', eventDate, venue.trim(), notes || null]
    );

    const booking = await pool.query(
      `SELECT b.*, c.name AS client_name, p.name AS package_name, be.event_date, be.venue
       FROM bookings b JOIN client c ON c.id = b.client_id JOIN packages p ON p.id = b.package_id
       LEFT JOIN LATERAL (SELECT event_date, venue FROM booking_events WHERE booking_id = b.id LIMIT 1) be ON true
       WHERE b.id = $1`,
      [result.rows[0].id]
    );
    return res.status(201).json({ success: true, booking: booking.rows[0] });
  } catch (error) {
    console.error('Error creating booking:', error);
    if (error.code === '23505') return res.status(409).json({ error: 'Booking number already exists' });
    return res.status(500).json({ error: 'Failed to create booking' });
  }
});

// GET /api/bookings/:id - Get one workspace-scoped booking
app.get('/api/bookings/:id', async (req, res) => {
  try {
    const result = await pool.query(
            `SELECT b.*, c.name AS client_name, p.name AS package_name,
              be.event_date, be.venue,
              COALESCE((SELECT SUM(amount) FROM payments
            WHERE booking_id = b.id AND workspace_id = b.workspace_id AND status = 'completed'), 0) AS amount_paid,
              COALESCE((SELECT json_agg(json_build_object(
            'id', e.id, 'event_name', e.event_name, 'event_date', e.event_date, 'venue', e.venue)
            ORDER BY e.event_date)
            FROM booking_events e WHERE e.booking_id = b.id AND e.workspace_id = b.workspace_id), '[]') AS event_days,
              COALESCE((SELECT json_agg(json_build_object(
            'installment_name', ps.installment_name, 'percentage', ps.percentage, 'timing', ps.timing)
            ORDER BY ps.payment_order)
            FROM payment_schedules ps WHERE ps.package_id = p.id AND ps.workspace_id = p.workspace_id), '[]') AS payment_schedule,
              COALESCE((SELECT json_agg(json_build_object(
            'day_number', pd.day_number, 'event_type', pd.event_type,
            'roles', COALESCE((SELECT json_agg(json_build_object('role', ct.name, 'quantity', pdc.quantity))
                  FROM package_day_crew pdc JOIN crew_types ct ON ct.id = pdc.crew_type_id
                  WHERE pdc.package_day_id = pd.id), '[]'))
            ORDER BY pd.day_number)
            FROM package_days pd WHERE pd.package_id = p.id AND pd.workspace_id = p.workspace_id), '[]') AS package_crew_plan,
              COALESCE((SELECT json_agg(json_build_object(
            'id', ca.id, 'staff_name', u.staff_name, 'assigned_role', ca.assigned_role,
            'event_name', ev.event_name, 'event_date', ev.event_date,
            'venue', ev.venue, 'status', ca.status, 'start_time', ca.start_time)
            ORDER BY ev.event_date, u.staff_name)
            FROM crew_assignments ca
            JOIN users u ON u.id = ca.staff_id AND u.workspace_id = ca.workspace_id
            JOIN booking_events ev ON ev.id = ca.booking_event_id AND ev.workspace_id = ca.workspace_id
            WHERE ev.booking_id = b.id AND ev.workspace_id = b.workspace_id), '[]') AS crew_assignments,
              COALESCE((SELECT json_agg(json_build_object(
            'id', r.id, 'reminder_type', r.reminder_type, 'days_before_event', r.days_before_event,
            'scheduled_date', r.scheduled_date, 'scheduled_time', r.scheduled_time, 'status', r.status)
            ORDER BY r.scheduled_date, r.scheduled_time)
            FROM reminders r WHERE r.booking_id = b.id AND r.workspace_id = b.workspace_id), '[]') AS reminders
       FROM bookings b
       JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       JOIN packages p ON p.id = b.package_id AND p.workspace_id = b.workspace_id
       LEFT JOIN LATERAL (
         SELECT event_date, venue FROM booking_events
         WHERE booking_id = b.id ORDER BY event_date ASC LIMIT 1
       ) be ON true
       WHERE b.id = $1 AND b.workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    return res.json({ success: true, booking: result.rows[0] });
  } catch (error) {
    console.error('Error fetching booking:', error);
    return res.status(500).json({ error: 'Failed to fetch booking' });
  }
});

// PUT /api/bookings/:id - Update booking
app.put('/api/bookings/:id', requireAdmin, async (req, res) => {
  const { clientId, packageId, bookingDate, eventDate, totalAmount, venue, eventType, status, currentWorkflowStage, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE bookings
       SET client_id = COALESCE($1, client_id),
           package_id = COALESCE($2, package_id),
           booking_date = COALESCE($3::date, booking_date),
           total_amount = COALESCE($4, total_amount),
           venue = COALESCE($5, venue),
           status = COALESCE($6, status),
           current_workflow_stage = COALESCE($7, current_workflow_stage),
           notes = COALESCE($8, notes),
           updated_at = NOW()
       WHERE id = $9 AND workspace_id = $10
       RETURNING *`,
      [clientId, packageId, bookingDate, totalAmount, venue, status, currentWorkflowStage, notes, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    return res.json({ success: true, booking: result.rows[0] });
  } catch (error) {
    console.error('Error updating booking:', error);
    return res.status(500).json({ error: 'Failed to update booking' });
  }
});

// DELETE /api/bookings/:id - Delete booking
app.delete('/api/bookings/:id', requireAdmin, async (req, res) => {
  const { id } = req.params;

  try {
    // Get booking details before deletion for logging
    const bookingCheck = await pool.query(
      `SELECT booking_number, client_id FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [id, req.user.workspace_id]
    );

    if (bookingCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    const bookingNumber = bookingCheck.rows[0].booking_number;

    // Delete booking (cascade will handle related records)
    const result = await pool.query(
      `DELETE FROM bookings
       WHERE id = $1 AND workspace_id = $2
       RETURNING booking_number`,
      [id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'booking_deleted',
      description: `Deleted booking ${bookingNumber}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, message: 'Booking deleted successfully' });
  } catch (error) {
    console.error('Error deleting booking:', error);
    return res.status(500).json({ error: 'Failed to delete booking' });
  }
});

// ============================================
// SERVICE MASTER API
// ============================================
app.get('/api/services', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM service_master
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, services: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching services:', error);
    return res.status(500).json({ error: 'Failed to fetch services' });
  }
});

app.post('/api/services', requireAdmin, async (req, res) => {
  const { name, description, category, is_active } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Service name is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO service_master (workspace_id, name, description, category, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.workspace_id, String(name).trim(), description?.trim() || null, category || null, is_active !== undefined ? Boolean(is_active) : true]
    );

    return res.status(201).json({ success: true, service: result.rows[0] });
  } catch (error) {
    console.error('Error creating service:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A service with this name already exists in this workspace' });
    }
    return res.status(500).json({ error: 'Failed to create service' });
  }
});

app.get('/api/services/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM service_master WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    return res.json({ success: true, service: result.rows[0] });
  } catch (error) {
    console.error('Error fetching service:', error);
    return res.status(500).json({ error: 'Failed to fetch service' });
  }
});

app.put('/api/services/:id', requireAdmin, async (req, res) => {
  const { name, description, category, is_active } = req.body;

  try {
    const result = await pool.query(
      `UPDATE service_master
       SET name = COALESCE($1, name),
           description = $2,
           category = $3,
           is_active = COALESCE($4, is_active),
           updated_at = NOW()
       WHERE id = $5 AND workspace_id = $6
       RETURNING *`,
      [name?.trim() || null, description?.trim() || null, category || null, is_active !== undefined ? Boolean(is_active) : null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Service not found' });
    }

    return res.json({ success: true, service: result.rows[0] });
  } catch (error) {
    console.error('Error updating service:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A service with this name already exists in this workspace' });
    }
    return res.status(500).json({ error: 'Failed to update service' });
  }
});

// ============================================
// STAFF API
// ============================================
app.get('/api/staff', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM staff
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, staff: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching staff:', error);
    return res.status(500).json({ error: 'Failed to fetch staff' });
  }
});

app.post('/api/staff', async (req, res) => {
  const { name, email, phone, role, availability, joining_date, status, notes } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Staff name is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO staff (workspace_id, user_id, name, email, phone, role, availability, joining_date, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.workspace_id, null, String(name).trim(), email?.trim() || null, phone?.trim() || null, role || 'team_member', availability || 'available', joining_date || null, status || 'active', notes?.trim() || null]
    );

    return res.status(201).json({ success: true, member: result.rows[0] });
  } catch (error) {
    console.error('Error creating staff member:', error);
    return res.status(500).json({ error: 'Failed to create staff member' });
  }
});

app.get('/api/staff/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM staff WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    return res.json({ success: true, member: result.rows[0] });
  } catch (error) {
    console.error('Error fetching staff member:', error);
    return res.status(500).json({ error: 'Failed to fetch staff member' });
  }
});

app.put('/api/staff/:id', requireAdmin, async (req, res) => {
  const { name, email, phone, role, availability, joining_date, status, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE staff
       SET name = COALESCE($1, name),
           email = $2,
           phone = $3,
           role = COALESCE($4, role),
           availability = COALESCE($5, availability),
           joining_date = $6,
           status = COALESCE($7, status),
           notes = $8,
           updated_at = NOW()
       WHERE id = $9 AND workspace_id = $10
       RETURNING *`,
      [name?.trim() || null, email?.trim() || null, phone?.trim() || null, role || null, availability || null, joining_date || null, status || null, notes?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Staff member not found' });
    }

    return res.json({ success: true, member: result.rows[0] });
  } catch (error) {
    console.error('Error updating staff member:', error);
    return res.status(500).json({ error: 'Failed to update staff member' });
  }
});

// ============================================
// FREELANCERS API
// ============================================
app.get('/api/freelancers', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM freelancers
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [req.user.workspace_id]
    );

    // Transform database records to match frontend Professional interface
    const professionals = result.rows.map(f => ({
      id: f.id,
      initials: f.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
      name: f.name,
      verified: f.verified,
      type: f.profile_type === 'individual' ? 'Individual' : 'Team',
      experienceYears: f.experience_years || 0,
      city: f.city || '',
      state: f.state || '',
      skills: f.skills || [f.specialization],
      summary: f.summary || f.notes || '',
      availableRate: f.rate || 0,
      email: f.email || '',
      phone: f.phone || ''
    }));

    return res.json({ success: true, professionals, count: professionals.length });
  } catch (error) {
    console.error('Error fetching freelancers:', error);
    return res.status(500).json({ error: 'Failed to fetch freelancers' });
  }
});

app.post('/api/freelancers', async (req, res) => {
  const { name, email, phone, specialization, availability, status, rate, notes, skills, experience_years, city, state, verified, profile_type, summary, portfolio_url } = req.body;

  if (!name || !String(name).trim()) {
    return res.status(400).json({ error: 'Freelancer name is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO freelancers (workspace_id, name, email, phone, specialization, availability, status, rate, notes, skills, experience_years, city, state, verified, profile_type, summary, portfolio_url)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11, $12, $13, $14, $15, $16, $17)
       RETURNING *`,
      [req.user.workspace_id, String(name).trim(), email?.trim() || null, phone?.trim() || null, specialization || 'general', availability || 'available', status || 'active', rate !== undefined && rate !== null ? Number(rate) : null, notes?.trim() || null, skills || null, experience_years !== undefined && experience_years !== null ? Number(experience_years) : null, city?.trim() || null, state?.trim() || null, verified !== undefined ? verified : false, profile_type || 'individual', summary?.trim() || null, portfolio_url?.trim() || null]
    );

    const f = result.rows[0];
    const professional = {
      id: f.id,
      initials: f.name.split(' ').map(n => n[0]).join('').toUpperCase().slice(0, 2),
      name: f.name,
      verified: f.verified ?? false,
      type: f.profile_type === 'team' ? 'Team' : 'Individual',
      experienceYears: f.experience_years || 0,
      city: f.city || '',
      state: f.state || '',
      skills: f.skills || [f.specialization],
      summary: f.summary || f.notes || '',
      availableRate: f.rate || 0,
      email: f.email || '',
      phone: f.phone || ''
    };

    return res.status(201).json({ success: true, freelancer: f, professional });
  } catch (error) {
    console.error('Error creating freelancer:', error);
    return res.status(500).json({ error: 'Failed to create freelancer' });
  }
});

app.get('/api/freelancers/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM freelancers WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Freelancer not found' });
    }

    return res.json({ success: true, freelancer: result.rows[0] });
  } catch (error) {
    console.error('Error fetching freelancer:', error);
    return res.status(500).json({ error: 'Failed to fetch freelancer' });
  }
});

app.put('/api/freelancers/:id', requireAdmin, async (req, res) => {
  const { name, email, phone, specialization, availability, status, rate, notes, skills, experience_years, city, state, verified, profile_type, summary, portfolio_url } = req.body;

  try {
    const result = await pool.query(
      `UPDATE freelancers
       SET name = COALESCE($1, name),
           email = $2,
           phone = $3,
           specialization = COALESCE($4, specialization),
           availability = COALESCE($5, availability),
           status = COALESCE($6, status),
           rate = $7,
           notes = $8,
           skills = $9,
           experience_years = $10,
           city = $11,
           state = $12,
           verified = COALESCE($13, verified),
           profile_type = COALESCE($14, profile_type),
           summary = $15,
           portfolio_url = $16,
           updated_at = NOW()
       WHERE id = $17 AND workspace_id = $18
       RETURNING *`,
      [name?.trim() || null, email?.trim() || null, phone?.trim() || null, specialization || null, availability || null, status || null, rate !== undefined && rate !== null ? Number(rate) : null, notes?.trim() || null, skills || null, experience_years !== undefined && experience_years !== null ? Number(experience_years) : null, city?.trim() || null, state?.trim() || null, verified !== undefined ? verified : null, profile_type || null, summary?.trim() || null, portfolio_url?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Freelancer not found' });
    }

    return res.json({ success: true, freelancer: result.rows[0] });
  } catch (error) {
    console.error('Error updating freelancer:', error);
    return res.status(500).json({ error: 'Failed to update freelancer' });
  }
});

// ============================================
// MARKETPLACE WORK REQUESTS API
// ============================================
app.get('/api/marketplace-work-requests', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM marketplace_work_requests
       WHERE workspace_id = $1
       ORDER BY created_at DESC`,
      [req.user.workspace_id]
    );

    // Transform database records to match frontend WorkRequest interface
    const workRequests = result.rows.map(r => ({
      id: r.id,
      project: r.project_name,
      professionalRole: r.professional_role,
      professionalName: r.professional_name,
      professionalEmail: r.professional_email,
      professionalPhone: r.professional_phone,
      eventDate: r.event_date,
      venue: r.venue,
      budget: r.budget,
      status: r.status.charAt(0).toUpperCase() + r.status.slice(1) // Capitalize first letter
    }));

    return res.json({ success: true, workRequests, count: workRequests.length });
  } catch (error) {
    console.error('Error fetching marketplace work requests:', error);
    return res.status(500).json({ error: 'Failed to fetch marketplace work requests' });
  }
});

app.post('/api/marketplace-work-requests', async (req, res) => {
  const { project_name, professional_role, professional_name, professional_email, professional_phone, event_date, venue, budget, status, notes } = req.body;

  if (!project_name || !professional_role || !professional_name) {
    return res.status(400).json({ error: 'Project name, professional role, and professional name are required' });
  }

  try {
    // Convert status to lowercase for database storage
    const dbStatus = status ? status.toLowerCase() : 'pending';

    const result = await pool.query(
      `INSERT INTO marketplace_work_requests (workspace_id, project_name, professional_role, professional_name, professional_email, professional_phone, event_date, venue, budget, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.user.workspace_id, String(project_name).trim(), String(professional_role).trim(), String(professional_name).trim(), professional_email?.trim() || null, professional_phone?.trim() || null, event_date || null, venue?.trim() || null, budget !== undefined && budget !== null ? Number(budget) : null, dbStatus, notes?.trim() || null]
    );

    // Transform the response to match frontend interface
    const workRequest = {
      id: result.rows[0].id,
      project: result.rows[0].project_name,
      professionalRole: result.rows[0].professional_role,
      professionalName: result.rows[0].professional_name,
      professionalEmail: result.rows[0].professional_email,
      professionalPhone: result.rows[0].professional_phone,
      eventDate: result.rows[0].event_date,
      venue: result.rows[0].venue,
      budget: result.rows[0].budget,
      status: result.rows[0].status.charAt(0).toUpperCase() + result.rows[0].status.slice(1)
    };

    // Trigger work brief email delivery via Resend API
    if (result.rows[0].professional_email) {
      sendWorkBriefEmail({
        recipientEmail: result.rows[0].professional_email,
        professionalName: result.rows[0].professional_name,
        projectName: result.rows[0].project_name,
        professionalRole: result.rows[0].professional_role,
        eventDate: result.rows[0].event_date,
        venue: result.rows[0].venue,
        budget: result.rows[0].budget,
        contactPhone: result.rows[0].professional_phone,
        projectBrief: notes
      }).catch(err => console.error('Error in sendWorkBriefEmail background call:', err));
    }

    return res.status(201).json({ success: true, workRequest });
  } catch (error) {
    console.error('Error creating marketplace work request:', error);
    return res.status(500).json({ error: 'Failed to create marketplace work request' });
  }
});

app.get('/api/marketplace-work-requests/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM marketplace_work_requests WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Marketplace work request not found' });
    }

    return res.json({ success: true, workRequest: result.rows[0] });
  } catch (error) {
    console.error('Error fetching marketplace work request:', error);
    return res.status(500).json({ error: 'Failed to fetch marketplace work request' });
  }
});

app.put('/api/marketplace-work-requests/:id', async (req, res) => {
  const { project_name, professional_role, professional_name, professional_email, professional_phone, event_date, venue, budget, status, notes } = req.body;

  try {
    // Convert status to lowercase for database storage
    const dbStatus = status ? status.toLowerCase() : null;

    const result = await pool.query(
      `UPDATE marketplace_work_requests
       SET project_name = COALESCE($1, project_name),
           professional_role = COALESCE($2, professional_role),
           professional_name = COALESCE($3, professional_name),
           professional_email = $4,
           professional_phone = $5,
           event_date = $6,
           venue = $7,
           budget = $8,
           status = $9,
           notes = $10,
           updated_at = NOW()
       WHERE id = $11 AND workspace_id = $12
       RETURNING *`,
      [project_name?.trim() || null, professional_role?.trim() || null, professional_name?.trim() || null, professional_email?.trim() || null, professional_phone?.trim() || null, event_date || null, venue?.trim() || null, budget !== undefined && budget !== null ? Number(budget) : null, dbStatus, notes?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Marketplace work request not found' });
    }

    // Transform the response to match frontend interface
    const workRequest = {
      id: result.rows[0].id,
      project: result.rows[0].project_name,
      professionalRole: result.rows[0].professional_role,
      professionalName: result.rows[0].professional_name,
      professionalEmail: result.rows[0].professional_email,
      professionalPhone: result.rows[0].professional_phone,
      eventDate: result.rows[0].event_date,
      venue: result.rows[0].venue,
      budget: result.rows[0].budget,
      status: result.rows[0].status.charAt(0).toUpperCase() + result.rows[0].status.slice(1)
    };

    return res.json({ success: true, workRequest });
  } catch (error) {
    console.error('Error updating marketplace work request:', error);
    return res.status(500).json({ error: 'Failed to update marketplace work request' });
  }
});

app.delete('/api/marketplace-work-requests/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM marketplace_work_requests WHERE id = $1 AND workspace_id = $2 RETURNING *`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Marketplace work request not found' });
    }

    return res.json({ success: true, message: 'Marketplace work request deleted successfully' });
  } catch (error) {
    console.error('Error deleting marketplace work request:', error);
    return res.status(500).json({ error: 'Failed to delete marketplace work request' });
  }
});

// ============================================
// CLIENT REVIEWS API
// ============================================
app.get('/api/client-reviews', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM client_reviews
       WHERE workspace_id = $1
       ORDER BY sent_date DESC, created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, clientReviews: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching client reviews:', error);
    return res.status(500).json({ error: 'Failed to fetch client reviews' });
  }
});

app.post('/api/client-reviews', requireAdmin, async (req, res) => {
  const { booking_id, production_job_id, client_id, sent_date, response_date, review_status, comments } = req.body;

  if (!booking_id || !production_job_id || !client_id) {
    return res.status(400).json({ error: 'Booking, production job, and client are required' });
  }

  try {
    const bookingCheck = await pool.query(
      `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [booking_id, req.user.workspace_id]
    );
    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found in this workspace' });
    }

    const jobCheck = await pool.query(
      `SELECT id FROM production_jobs WHERE id = $1 AND workspace_id = $2`,
      [production_job_id, req.user.workspace_id]
    );
    if (jobCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Production job not found in this workspace' });
    }

    const clientCheck = await pool.query(
      `SELECT id FROM client WHERE id = $1 AND workspace_id = $2`,
      [client_id, req.user.workspace_id]
    );
    if (clientCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Client not found in this workspace' });
    }

    const result = await pool.query(
      `INSERT INTO client_reviews (workspace_id, booking_id, production_job_id, client_id, sent_date, response_date, review_status, comments)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.user.workspace_id, booking_id, production_job_id, client_id, sent_date || new Date().toISOString().slice(0, 10), response_date || null, review_status || 'pending', comments?.trim() || null]
    );

    return res.status(201).json({ success: true, clientReview: result.rows[0] });
  } catch (error) {
    console.error('Error creating client review:', error);
    return res.status(500).json({ error: 'Failed to create client review' });
  }
});

// ============================================
// INVOICES API
// ============================================
app.get('/api/invoices', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, b.booking_number, c.name AS client_name
       FROM invoices i
       JOIN bookings b ON b.id = i.booking_id AND b.workspace_id = i.workspace_id
       JOIN client c ON c.id = b.client_id AND c.workspace_id = i.workspace_id
       WHERE i.workspace_id = $1
       ORDER BY i.invoice_date DESC, i.created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, invoices: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching invoices:', error);
    return res.status(500).json({ error: 'Failed to fetch invoices' });
  }
});

app.post('/api/invoices', requireAdmin, async (req, res) => {
  const { booking_id, invoice_number, invoice_date, due_date, total_amount, status, notes } = req.body;

  if (!booking_id || !invoice_number || total_amount === undefined) {
    return res.status(400).json({ error: 'Booking, invoice number, and total amount are required' });
  }

  try {
    const bookingCheck = await pool.query(
      `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [booking_id, req.user.workspace_id]
    );
    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found in this workspace' });
    }

    const result = await pool.query(
      `INSERT INTO invoices (workspace_id, booking_id, invoice_number, invoice_date, due_date, total_amount, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.user.workspace_id, booking_id, String(invoice_number).trim(), invoice_date || new Date().toISOString().slice(0, 10), due_date || null, Number(total_amount), status || 'draft', notes?.trim() || null]
    );

    return res.status(201).json({ success: true, invoice: result.rows[0] });
  } catch (error) {
    console.error('Error creating invoice:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Invoice number already exists in this workspace' });
    }
    return res.status(500).json({ error: 'Failed to create invoice' });
  }
});

app.get('/api/invoices/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT i.*, b.booking_number, c.name AS client_name
       FROM invoices i
       JOIN bookings b ON b.id = i.booking_id AND b.workspace_id = i.workspace_id
       JOIN client c ON c.id = b.client_id AND c.workspace_id = i.workspace_id
       WHERE i.id = $1 AND i.workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    return res.json({ success: true, invoice: result.rows[0] });
  } catch (error) {
    console.error('Error fetching invoice:', error);
    return res.status(500).json({ error: 'Failed to fetch invoice' });
  }
});

app.put('/api/invoices/:id', requireAdmin, async (req, res) => {
  const { booking_id, invoice_number, invoice_date, due_date, total_amount, status, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE invoices
       SET booking_id = COALESCE($1, booking_id),
           invoice_number = COALESCE($2, invoice_number),
           invoice_date = COALESCE($3, invoice_date),
           due_date = $4,
           total_amount = COALESCE($5, total_amount),
           status = COALESCE($6, status),
           notes = $7,
           updated_at = NOW()
       WHERE id = $8 AND workspace_id = $9
       RETURNING *`,
      [booking_id || null, invoice_number?.trim() || null, invoice_date || null, due_date || null, total_amount !== undefined ? Number(total_amount) : null, status || null, notes?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Invoice not found' });
    }

    return res.json({ success: true, invoice: result.rows[0] });
  } catch (error) {
    console.error('Error updating invoice:', error);
    return res.status(500).json({ error: 'Failed to update invoice' });
  }
});

// ============================================
// PAYMENTS API
// ============================================
app.get('/api/payments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, i.invoice_number, b.booking_number
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id AND i.workspace_id = p.workspace_id
       JOIN bookings b ON b.id = p.booking_id AND b.workspace_id = p.workspace_id
       WHERE p.workspace_id = $1
       ORDER BY p.payment_date DESC, p.created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, payments: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching payments:', error);
    return res.status(500).json({ error: 'Failed to fetch payments' });
  }
});

app.post('/api/payments', requireAdmin, async (req, res) => {
  const { invoice_id, booking_id, amount, payment_date, payment_method, transaction_reference, status, notes } = req.body;

  if (!invoice_id || !booking_id || amount === undefined) {
    return res.status(400).json({ error: 'Invoice, booking, and amount are required' });
  }

  try {
    const invoiceCheck = await pool.query(
      `SELECT id, booking_id FROM invoices WHERE id = $1 AND workspace_id = $2`,
      [invoice_id, req.user.workspace_id]
    );
    if (invoiceCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Invoice not found in this workspace' });
    }

    const bookingCheck = await pool.query(
      `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [booking_id, req.user.workspace_id]
    );
    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found in this workspace' });
    }

    const result = await pool.query(
      `INSERT INTO payments (workspace_id, invoice_id, booking_id, amount, payment_date, payment_method, transaction_reference, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.workspace_id, invoice_id, booking_id, Number(amount), payment_date || new Date().toISOString().slice(0, 10), payment_method || null, transaction_reference?.trim() || null, status || 'pending', notes?.trim() || null]
    );

    return res.status(201).json({ success: true, payment: result.rows[0] });
  } catch (error) {
    console.error('Error creating payment:', error);
    return res.status(500).json({ error: 'Failed to create payment' });
  }
});

app.get('/api/payments/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT p.*, i.invoice_number, b.booking_number
       FROM payments p
       JOIN invoices i ON i.id = p.invoice_id AND i.workspace_id = p.workspace_id
       JOIN bookings b ON b.id = p.booking_id AND b.workspace_id = p.workspace_id
       WHERE p.id = $1 AND p.workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    return res.json({ success: true, payment: result.rows[0] });
  } catch (error) {
    console.error('Error fetching payment:', error);
    return res.status(500).json({ error: 'Failed to fetch payment' });
  }
});

app.put('/api/payments/:id', requireAdmin, async (req, res) => {
  const { invoice_id, booking_id, amount, payment_date, payment_method, transaction_reference, status, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE payments
       SET invoice_id = COALESCE($1, invoice_id),
           booking_id = COALESCE($2, booking_id),
           amount = COALESCE($3, amount),
           payment_date = COALESCE($4, payment_date),
           payment_method = $5,
           transaction_reference = $6,
           status = COALESCE($7, status),
           notes = $8,
           updated_at = NOW()
       WHERE id = $9 AND workspace_id = $10
       RETURNING *`,
      [invoice_id || null, booking_id || null, amount !== undefined ? Number(amount) : null, payment_date || null, payment_method || null, transaction_reference?.trim() || null, status || null, notes?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Payment not found' });
    }

    return res.json({ success: true, payment: result.rows[0] });
  } catch (error) {
    console.error('Error updating payment:', error);
    return res.status(500).json({ error: 'Failed to update payment' });
  }
});

// ============================================
// PRODUCTION JOBS API
// ============================================
app.get('/api/production-jobs', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pj.*, b.booking_number, s.name AS service_name, st.name AS assigned_staff_name
       FROM production_jobs pj
       JOIN bookings b ON b.id = pj.booking_id AND b.workspace_id = pj.workspace_id
       JOIN service_master s ON s.id = pj.service_id AND s.workspace_id = pj.workspace_id
       LEFT JOIN staff st ON st.id = pj.assigned_staff_id AND st.workspace_id = pj.workspace_id
       WHERE pj.workspace_id = $1
       ORDER BY pj.due_date ASC NULLS LAST, pj.created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, jobs: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching production jobs:', error);
    return res.status(500).json({ error: 'Failed to fetch production jobs' });
  }
});

app.post('/api/production-jobs', requireAdmin, async (req, res) => {
  const { booking_id, service_id, assigned_staff_id, job_name, start_date, due_date, status, priority, completion_date, notes } = req.body;

  if (!booking_id || !service_id || !job_name) {
    return res.status(400).json({ error: 'Booking, service, and job name are required' });
  }

  try {
    const bookingCheck = await pool.query(
      `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [booking_id, req.user.workspace_id]
    );
    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found in this workspace' });
    }

    const serviceCheck = await pool.query(
      `SELECT id FROM service_master WHERE id = $1 AND workspace_id = $2`,
      [service_id, req.user.workspace_id]
    );
    if (serviceCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Service not found in this workspace' });
    }

    if (assigned_staff_id) {
      const staffCheck = await pool.query(
        `SELECT id FROM staff WHERE id = $1 AND workspace_id = $2`,
        [assigned_staff_id, req.user.workspace_id]
      );
      if (staffCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Assigned staff not found in this workspace' });
      }
    }

    const result = await pool.query(
      `INSERT INTO production_jobs (workspace_id, booking_id, service_id, assigned_staff_id, job_name, start_date, due_date, status, priority, completion_date, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10, $11)
       RETURNING *`,
      [req.user.workspace_id, booking_id, service_id, assigned_staff_id || null, String(job_name).trim(), start_date || null, due_date || null, status || 'pending', priority || 'normal', completion_date || null, notes?.trim() || null]
    );

    return res.status(201).json({ success: true, job: result.rows[0] });
  } catch (error) {
    console.error('Error creating production job:', error);
    return res.status(500).json({ error: 'Failed to create production job' });
  }
});

app.get('/api/production-jobs/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pj.*, b.booking_number, s.name AS service_name, st.name AS assigned_staff_name
       FROM production_jobs pj
       JOIN bookings b ON b.id = pj.booking_id AND b.workspace_id = pj.workspace_id
       JOIN service_master s ON s.id = pj.service_id AND s.workspace_id = pj.workspace_id
       LEFT JOIN staff st ON st.id = pj.assigned_staff_id AND st.workspace_id = pj.workspace_id
       WHERE pj.id = $1 AND pj.workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Production job not found' });
    }

    return res.json({ success: true, job: result.rows[0] });
  } catch (error) {
    console.error('Error fetching production job:', error);
    return res.status(500).json({ error: 'Failed to fetch production job' });
  }
});

app.put('/api/production-jobs/:id', requireAdmin, async (req, res) => {
  const { booking_id, service_id, assigned_staff_id, job_name, start_date, due_date, status, priority, completion_date, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE production_jobs
       SET booking_id = COALESCE($1, booking_id),
           service_id = COALESCE($2, service_id),
           assigned_staff_id = $3,
           job_name = COALESCE($4, job_name),
           start_date = $5,
           due_date = $6,
           status = COALESCE($7, status),
           priority = COALESCE($8, priority),
           completion_date = $9,
           notes = $10,
           updated_at = NOW()
       WHERE id = $11 AND workspace_id = $12
       RETURNING *`,
      [booking_id || null, service_id || null, assigned_staff_id || null, job_name?.trim() || null, start_date || null, due_date || null, status || null, priority || null, completion_date || null, notes?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Production job not found' });
    }

    return res.json({ success: true, job: result.rows[0] });
  } catch (error) {
    console.error('Error updating production job:', error);
    return res.status(500).json({ error: 'Failed to update production job' });
  }
});

// ============================================
// QC REVIEWS API
// ============================================
app.get('/api/qc-reviews', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT qr.*, pj.job_name, s.name AS reviewer_name
       FROM qc_reviews qr
       JOIN production_jobs pj ON pj.id = qr.production_job_id AND pj.workspace_id = qr.workspace_id
       JOIN staff s ON s.id = qr.reviewer_staff_id AND s.workspace_id = qr.workspace_id
       WHERE qr.workspace_id = $1
       ORDER BY qr.review_date DESC, qr.created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, qcReviews: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching QC reviews:', error);
    return res.status(500).json({ error: 'Failed to fetch QC reviews' });
  }
});

app.post('/api/qc-reviews', requireAdmin, async (req, res) => {
  const { production_job_id, reviewer_staff_id, review_date, result, comments, status } = req.body;

  if (!production_job_id || !reviewer_staff_id) {
    return res.status(400).json({ error: 'Production job and reviewer are required' });
  }

  try {
    const jobCheck = await pool.query(
      `SELECT id FROM production_jobs WHERE id = $1 AND workspace_id = $2`,
      [production_job_id, req.user.workspace_id]
    );
    if (jobCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Production job not found in this workspace' });
    }

    const reviewerCheck = await pool.query(
      `SELECT id FROM staff WHERE id = $1 AND workspace_id = $2`,
      [reviewer_staff_id, req.user.workspace_id]
    );
    if (reviewerCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Reviewer staff not found in this workspace' });
    }

    const resultRow = await pool.query(
      `INSERT INTO qc_reviews (workspace_id, production_job_id, reviewer_staff_id, review_date, result, comments, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [req.user.workspace_id, production_job_id, reviewer_staff_id, review_date || new Date().toISOString().slice(0, 10), result || 'needs_correction', comments?.trim() || null, status || 'pending']
    );

    return res.status(201).json({ success: true, qcReview: resultRow.rows[0] });
  } catch (error) {
    console.error('Error creating QC review:', error);
    return res.status(500).json({ error: 'Failed to create QC review' });
  }
});

app.get('/api/qc-reviews/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT qr.*, pj.job_name, s.name AS reviewer_name
       FROM qc_reviews qr
       JOIN production_jobs pj ON pj.id = qr.production_job_id AND pj.workspace_id = qr.workspace_id
       JOIN staff s ON s.id = qr.reviewer_staff_id AND s.workspace_id = qr.workspace_id
       WHERE qr.id = $1 AND qr.workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'QC review not found' });
    }

    return res.json({ success: true, qcReview: result.rows[0] });
  } catch (error) {
    console.error('Error fetching QC review:', error);
    return res.status(500).json({ error: 'Failed to fetch QC review' });
  }
});

app.put('/api/qc-reviews/:id', requireAdmin, async (req, res) => {
  const { production_job_id, reviewer_staff_id, review_date, result, comments, status } = req.body;

  try {
    const resultRow = await pool.query(
      `UPDATE qc_reviews
       SET production_job_id = COALESCE($1, production_job_id),
           reviewer_staff_id = COALESCE($2, reviewer_staff_id),
           review_date = COALESCE($3, review_date),
           result = COALESCE($4, result),
           comments = $5,
           status = COALESCE($6, status),
           updated_at = NOW()
       WHERE id = $7 AND workspace_id = $8
       RETURNING *`,
      [production_job_id || null, reviewer_staff_id || null, review_date || null, result || null, comments?.trim() || null, status || null, req.params.id, req.user.workspace_id]
    );

    if (resultRow.rows.length === 0) {
      return res.status(404).json({ error: 'QC review not found' });
    }

    return res.json({ success: true, qcReview: resultRow.rows[0] });
  } catch (error) {
    console.error('Error updating QC review:', error);
    return res.status(500).json({ error: 'Failed to update QC review' });
  }
});

// ============================================
// REVISIONS API
// ============================================
app.get('/api/revisions', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, pj.job_name, cr.review_status, s.name AS assigned_staff_name
       FROM revisions r
       JOIN production_jobs pj ON pj.id = r.production_job_id AND pj.workspace_id = r.workspace_id
       LEFT JOIN client_reviews cr ON cr.id = r.client_review_id AND cr.workspace_id = r.workspace_id
       LEFT JOIN staff s ON s.id = r.assigned_staff_id AND s.workspace_id = r.workspace_id
       WHERE r.workspace_id = $1
       ORDER BY r.due_date ASC NULLS LAST, r.created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, revisions: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching revisions:', error);
    return res.status(500).json({ error: 'Failed to fetch revisions' });
  }
});

app.post('/api/revisions', requireAdmin, async (req, res) => {
  const { client_review_id, production_job_id, revision_number, requested_changes, assigned_staff_id, due_date, completion_date, status } = req.body;

  if (!client_review_id || !production_job_id || !revision_number || !requested_changes) {
    return res.status(400).json({ error: 'Client review, production job, revision number, and requested changes are required' });
  }

  try {
    const clientReviewCheck = await pool.query(
      `SELECT id FROM client_reviews WHERE id = $1 AND workspace_id = $2`,
      [client_review_id, req.user.workspace_id]
    );
    if (clientReviewCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Client review not found in this workspace' });
    }

    const jobCheck = await pool.query(
      `SELECT id FROM production_jobs WHERE id = $1 AND workspace_id = $2`,
      [production_job_id, req.user.workspace_id]
    );
    if (jobCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Production job not found in this workspace' });
    }

    if (assigned_staff_id) {
      const staffCheck = await pool.query(
        `SELECT id FROM staff WHERE id = $1 AND workspace_id = $2`,
        [assigned_staff_id, req.user.workspace_id]
      );
      if (staffCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Assigned staff not found in this workspace' });
      }
    }

    const result = await pool.query(
      `INSERT INTO revisions (workspace_id, client_review_id, production_job_id, revision_number, requested_changes, assigned_staff_id, due_date, completion_date, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.workspace_id, client_review_id, production_job_id, Number(revision_number), String(requested_changes).trim(), assigned_staff_id || null, due_date || null, completion_date || null, status || 'pending']
    );

    return res.status(201).json({ success: true, revision: result.rows[0] });
  } catch (error) {
    console.error('Error creating revision:', error);
    return res.status(500).json({ error: 'Failed to create revision' });
  }
});

app.get('/api/revisions/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT r.*, pj.job_name, cr.review_status, s.name AS assigned_staff_name
       FROM revisions r
       JOIN production_jobs pj ON pj.id = r.production_job_id AND pj.workspace_id = r.workspace_id
       LEFT JOIN client_reviews cr ON cr.id = r.client_review_id AND cr.workspace_id = r.workspace_id
       LEFT JOIN staff s ON s.id = r.assigned_staff_id AND s.workspace_id = r.workspace_id
       WHERE r.id = $1 AND r.workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Revision not found' });
    }

    return res.json({ success: true, revision: result.rows[0] });
  } catch (error) {
    console.error('Error fetching revision:', error);
    return res.status(500).json({ error: 'Failed to fetch revision' });
  }
});

app.put('/api/revisions/:id', requireAdmin, async (req, res) => {
  const { client_review_id, production_job_id, revision_number, requested_changes, assigned_staff_id, due_date, completion_date, status } = req.body;

  try {
    const result = await pool.query(
      `UPDATE revisions
       SET client_review_id = COALESCE($1, client_review_id),
           production_job_id = COALESCE($2, production_job_id),
           revision_number = COALESCE($3, revision_number),
           requested_changes = COALESCE($4, requested_changes),
           assigned_staff_id = $5,
           due_date = $6,
           completion_date = $7,
           status = COALESCE($8, status),
           updated_at = NOW()
       WHERE id = $9 AND workspace_id = $10
       RETURNING *`,
      [client_review_id || null, production_job_id || null, revision_number !== undefined ? Number(revision_number) : null, requested_changes?.trim() || null, assigned_staff_id || null, due_date || null, completion_date || null, status || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Revision not found' });
    }

    return res.json({ success: true, revision: result.rows[0] });
  } catch (error) {
    console.error('Error updating revision:', error);
    return res.status(500).json({ error: 'Failed to update revision' });
  }
});

// ============================================
// BOOKING EVENTS API
// ============================================

// Get all booking events
app.get('/api/booking-events', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT be.*, b.booking_number, c.name AS client_name
       FROM booking_events be
       JOIN bookings b ON b.id = be.booking_id AND b.workspace_id = be.workspace_id
       JOIN client c ON c.id = b.client_id AND c.workspace_id = be.workspace_id
       WHERE be.workspace_id = $1
       ORDER BY be.event_date ASC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, events: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching booking events:', error);
    return res.status(500).json({ error: 'Failed to fetch booking events' });
  }
});

// Add booking event
app.post('/api/booking-events', async (req, res) => {
  const { booking_id, event_name, event_date, venue, notes } = req.body;

  if (!booking_id || !event_name) {
    return res.status(400).json({ error: 'Booking ID and event name are required' });
  }

  try {
    const bookingCheck = await pool.query(
      `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [booking_id, req.user.workspace_id]
    );

    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found in this workspace' });
    }

    const eventTypeResult = await pool.query(
      `SELECT id FROM event_type
       WHERE workspace_id = $1 AND LOWER(name) = LOWER($2)
       LIMIT 1`,
      [req.user.workspace_id, event_name.trim()]
    );
    let eventTypeId = eventTypeResult.rows[0]?.id;
    if (!eventTypeId) {
      const createdEventType = await pool.query(
        `INSERT INTO event_type (workspace_id, name)
         VALUES ($1, $2)
         ON CONFLICT (workspace_id, name) DO UPDATE SET is_active = true
         RETURNING id`,
        [req.user.workspace_id, event_name.trim()]
      );
      eventTypeId = createdEventType.rows[0]?.id;
    }

    const result = await pool.query(
      `INSERT INTO booking_events (workspace_id, booking_id, event_type_id, event_name, event_date, venue, notes)
       VALUES ($1, $2, $3, $4, $5::date, $6, $7)
       RETURNING *`,
      [req.user.workspace_id, booking_id, eventTypeId, event_name.trim(), event_date || '2099-12-31', venue?.trim() || null, notes?.trim() || null]
    );

    return res.status(201).json({ success: true, event: result.rows[0] });
  } catch (error) {
    console.error('Error creating booking event:', error);
    return res.status(500).json({ error: 'Failed to create booking event' });
  }
});

// Update booking event
app.put('/api/booking-events/:id', async (req, res) => {
  const { event_name, event_date, venue, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE booking_events
       SET event_name = COALESCE($1, event_name),
           event_date = $2,
           venue = $3,
           notes = $4,
           updated_at = NOW()
       WHERE id = $5 AND workspace_id = $6
       RETURNING *`,
      [event_name?.trim() || null, event_date || null, venue?.trim() || null, notes?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking event not found' });
    }

    return res.json({ success: true, event: result.rows[0] });
  } catch (error) {
    console.error('Error updating booking event:', error);
    return res.status(500).json({ error: 'Failed to update booking event' });
  }
});

// Delete booking event
app.delete('/api/booking-events/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM booking_events 
       WHERE id = $1 AND workspace_id = $2
       RETURNING *`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Booking event not found' });
    }

    return res.json({ success: true, message: 'Booking event deleted successfully' });
  } catch (error) {
    console.error('Error deleting booking event:', error);
    return res.status(500).json({ error: 'Failed to delete booking event' });
  }
});

// ============================================
// EQUIPMENT API
// ============================================
app.get('/api/equipment', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT e.*,
              COALESCE(u.staff_name, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), s.name) AS checked_out_with,
              ea.assigned_at AS checked_out_since,
              ea.returned_at AS checked_out_due
       FROM equipment e
       LEFT JOIN LATERAL (
         SELECT staff_id, assigned_at, returned_at
         FROM equipment_assignments
         WHERE equipment_id = e.id AND status = 'assigned'
         ORDER BY assigned_at DESC
         LIMIT 1
       ) ea ON true
       LEFT JOIN users u ON u.id = ea.staff_id
       LEFT JOIN staff s ON s.id = ea.staff_id
       WHERE e.workspace_id = $1
       ORDER BY e.created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, equipment: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching equipment:', error);
    return res.status(500).json({ error: 'Failed to fetch equipment' });
  }
});

app.post('/api/equipment', requireAdmin, async (req, res) => {
  const { name, equipment_type, serial_number, purchase_date, purchase_price, status, notes } = req.body;

  if (!name || !equipment_type) {
    return res.status(400).json({ error: 'Equipment name and type are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO equipment (workspace_id, name, equipment_type, serial_number, purchase_date, purchase_price, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8)
       RETURNING *`,
      [req.user.workspace_id, String(name).trim(), String(equipment_type).trim(), serial_number?.trim() || null, purchase_date || null, purchase_price !== undefined && purchase_price !== null ? Number(purchase_price) : null, status || 'available', notes?.trim() || null]
    );

    return res.status(201).json({ success: true, equipment: result.rows[0] });
  } catch (error) {
    console.error('Error creating equipment:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'An equipment item with this serial number already exists' });
    }
    return res.status(500).json({ error: 'Failed to create equipment' });
  }
});

app.get('/api/equipment/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM equipment WHERE id = $1 AND workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Equipment item not found' });
    }

    return res.json({ success: true, equipment: result.rows[0] });
  } catch (error) {
    console.error('Error fetching equipment item:', error);
    return res.status(500).json({ error: 'Failed to fetch equipment item' });
  }
});

app.put('/api/equipment/:id', requireAdmin, async (req, res) => {
  const { name, equipment_type, serial_number, purchase_date, purchase_price, status, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE equipment
       SET name = COALESCE($1, name),
           equipment_type = COALESCE($2, equipment_type),
           serial_number = $3,
           purchase_date = $4,
           purchase_price = $5,
           status = COALESCE($6, status),
           notes = $7,
           updated_at = NOW()
       WHERE id = $8 AND workspace_id = $9
       RETURNING *`,
      [name?.trim() || null, equipment_type?.trim() || null, serial_number?.trim() || null, purchase_date || null, purchase_price !== undefined && purchase_price !== null ? Number(purchase_price) : null, status || null, notes?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Equipment item not found' });
    }

    return res.json({ success: true, equipment: result.rows[0] });
  } catch (error) {
    console.error('Error updating equipment:', error);
    return res.status(500).json({ error: 'Failed to update equipment' });
  }
});

// ============================================
// EQUIPMENT ASSIGNMENTS API
// ============================================
app.get('/api/equipment-assignments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ea.*, e.name AS equipment_name,
              COALESCE(u.staff_name, NULLIF(TRIM(CONCAT(u.first_name, ' ', u.last_name)), ''), s.name) AS staff_name,
              be.event_name, be.event_date, be.venue
       FROM equipment_assignments ea
       JOIN equipment e ON e.id = ea.equipment_id
       LEFT JOIN users u ON u.id = ea.staff_id
       LEFT JOIN staff s ON s.id = ea.staff_id
       LEFT JOIN booking_events be ON be.id = ea.booking_event_id
       WHERE e.workspace_id = $1
       ORDER BY ea.assigned_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, assignments: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching equipment assignments:', error);
    return res.status(500).json({ error: 'Failed to fetch equipment assignments' });
  }
});

app.post('/api/equipment-assignments', requireAdmin, async (req, res) => {
  const { equipment_id, booking_event_id, staff_id, assigned_at, returned_at, status, notes } = req.body;

  if (!equipment_id) {
    return res.status(400).json({ error: 'Equipment is required' });
  }

  try {
    const equipmentCheck = await pool.query(
      `SELECT id FROM equipment WHERE id = $1 AND workspace_id = $2`,
      [equipment_id, req.user.workspace_id]
    );
    if (equipmentCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Equipment not found in this workspace' });
    }

    if (booking_event_id) {
      const eventCheck = await pool.query(
        `SELECT id FROM booking_events WHERE id = $1 AND workspace_id = $2`,
        [booking_event_id, req.user.workspace_id]
      );
      if (eventCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Booking event not found in this workspace' });
      }
    }

    const result = await pool.query(
      `INSERT INTO equipment_assignments (equipment_id, booking_event_id, staff_id, assigned_at, returned_at, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       RETURNING *`,
      [equipment_id, booking_event_id || null, staff_id || null, assigned_at || new Date().toISOString(), returned_at || null, status || 'assigned', notes?.trim() || null]
    );

    return res.status(201).json({ success: true, assignment: result.rows[0] });
  } catch (error) {
    console.error('Error creating equipment assignment:', error);
    return res.status(500).json({ error: 'Failed to create equipment assignment' });
  }
});

app.put('/api/equipment-assignments/return-by-equipment/:equipmentId', requireAdmin, async (req, res) => {
  try {
    // Mark active assignments for this equipment as returned
    await pool.query(
      `UPDATE equipment_assignments
       SET status = 'returned', returned_at = NOW(), updated_at = NOW()
       WHERE equipment_id = $1 AND status = 'assigned'`,
      [req.params.equipmentId]
    );

    // Update equipment status to available
    await pool.query(
      `UPDATE equipment
       SET status = 'available', updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2`,
      [req.params.equipmentId, req.user.workspace_id]
    );

    return res.json({ success: true, message: 'Equipment returned successfully' });
  } catch (error) {
    console.error('Error returning equipment:', error);
    return res.status(500).json({ error: 'Failed to return equipment' });
  }
});

// ============================================
// EQUIPMENT MAINTENANCE API
// ============================================
app.get('/api/equipment-maintenance', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT em.*, e.name AS equipment_name
       FROM equipment_maintenance em
       JOIN equipment e ON e.id = em.equipment_id AND e.workspace_id = em.workspace_id
       WHERE em.workspace_id = $1
       ORDER BY em.maintenance_date DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, maintenance: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching equipment maintenance:', error);
    return res.status(500).json({ error: 'Failed to fetch equipment maintenance' });
  }
});

app.post('/api/equipment-maintenance', requireAdmin, async (req, res) => {
  const { equipment_id, maintenance_type, description, maintenance_date, next_maintenance_date, cost, performed_by, status, notes } = req.body;

  if (!equipment_id || !description || !maintenance_type) {
    return res.status(400).json({ error: 'Equipment, maintenance type, and description are required' });
  }

  try {
    const equipmentCheck = await pool.query(
      `SELECT id FROM equipment WHERE id = $1 AND workspace_id = $2`,
      [equipment_id, req.user.workspace_id]
    );
    if (equipmentCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Equipment not found in this workspace' });
    }

    const result = await pool.query(
      `INSERT INTO equipment_maintenance (workspace_id, equipment_id, maintenance_type, description, maintenance_date, next_maintenance_date, cost, performed_by, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, $10)
       RETURNING *`,
      [req.user.workspace_id, equipment_id, maintenance_type, String(description).trim(), maintenance_date || new Date().toISOString().slice(0, 10), next_maintenance_date || null, cost !== undefined && cost !== null ? Number(cost) : 0, performed_by?.trim() || null, status || 'completed', notes?.trim() || null]
    );

    return res.status(201).json({ success: true, maintenance: result.rows[0] });
  } catch (error) {
    console.error('Error creating equipment maintenance:', error);
    return res.status(500).json({ error: 'Failed to create equipment maintenance' });
  }
});

// ============================================
// FILES API
// ============================================
app.get('/api/files', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM files WHERE workspace_id = $1 ORDER BY upload_date DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, files: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching files:', error);
    return res.status(500).json({ error: 'Failed to fetch files' });
  }
});

app.post('/api/files', requireAdmin, async (req, res) => {
  const { booking_id, file_name, file_type, category, storage_path, file_size, status, notes } = req.body;

  if (!booking_id || !file_name || !storage_path) {
    return res.status(400).json({ error: 'Booking, file name, and storage path are required' });
  }

  try {
    const bookingCheck = await pool.query(
      `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [booking_id, req.user.workspace_id]
    );
    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found in this workspace' });
    }

    const result = await pool.query(
      `INSERT INTO files (workspace_id, booking_id, file_name, file_type, category, storage_path, file_size, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.workspace_id, booking_id, String(file_name).trim(), file_type || null, category || 'general', String(storage_path).trim(), file_size !== undefined && file_size !== null ? Number(file_size) : null, status || 'active', notes?.trim() || null]
    );

    return res.status(201).json({ success: true, file: result.rows[0] });
  } catch (error) {
    console.error('Error creating file record:', error);
    return res.status(500).json({ error: 'Failed to create file record' });
  }
});

// ============================================
// DELIVERIES API
// ============================================
app.get('/api/deliveries', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM deliveries WHERE workspace_id = $1 ORDER BY delivery_date DESC NULLS LAST, created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, deliveries: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching deliveries:', error);
    return res.status(500).json({ error: 'Failed to fetch deliveries' });
  }
});

app.post('/api/deliveries', requireAdmin, async (req, res) => {
  const { booking_id, delivery_type, delivery_date, delivery_status, delivery_link, recipient, confirmation, notes } = req.body;

  if (!booking_id || !delivery_type) {
    return res.status(400).json({ error: 'Booking and delivery type are required' });
  }

  try {
    const bookingCheck = await pool.query(
      `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [booking_id, req.user.workspace_id]
    );
    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found in this workspace' });
    }

    const result = await pool.query(
      `INSERT INTO deliveries (workspace_id, booking_id, delivery_type, delivery_date, delivery_status, delivery_link, recipient, confirmation, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.workspace_id, booking_id, String(delivery_type).trim(), delivery_date || null, delivery_status || 'pending', delivery_link?.trim() || null, recipient?.trim() || null, Boolean(confirmation), notes?.trim() || null]
    );

    return res.status(201).json({ success: true, delivery: result.rows[0] });
  } catch (error) {
    console.error('Error creating delivery:', error);
    return res.status(500).json({ error: 'Failed to create delivery' });
  }
});

app.put('/api/deliveries/:id', requireAdmin, async (req, res) => {
  const { delivery_type, delivery_date, delivery_status, delivery_link, recipient, confirmation, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE deliveries
       SET delivery_type = COALESCE($1, delivery_type),
           delivery_date = $2,
           delivery_status = $3,
           delivery_link = $4,
           recipient = $5,
           confirmation = $6,
           notes = $7,
           updated_at = NOW()
       WHERE id = $8 AND workspace_id = $9
       RETURNING *`,
      [delivery_type?.trim() || null, delivery_date || null, delivery_status || 'pending', delivery_link?.trim() || null, recipient?.trim() || null, Boolean(confirmation), notes?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    return res.json({ success: true, delivery: result.rows[0] });
  } catch (error) {
    console.error('Error updating delivery:', error);
    return res.status(500).json({ error: 'Failed to update delivery' });
  }
});

app.delete('/api/deliveries/:id', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM deliveries 
       WHERE id = $1 AND workspace_id = $2
       RETURNING *`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Delivery not found' });
    }

    return res.json({ success: true, message: 'Delivery deleted successfully' });
  } catch (error) {
    console.error('Error deleting delivery:', error);
    return res.status(500).json({ error: 'Failed to delete delivery' });
  }
});

// ============================================
// STORAGE CATEGORIES API
// ============================================
app.get('/api/storage-categories', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM storage_categories WHERE workspace_id = $1 ORDER BY name ASC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, categories: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching storage categories:', error);
    return res.status(500).json({ error: 'Failed to fetch storage categories' });
  }
});

app.post('/api/storage-categories', requireAdmin, async (req, res) => {
  const { name, description, is_active } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Category name is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO storage_categories (workspace_id, name, description, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.workspace_id, String(name).trim(), description?.trim() || null, is_active !== undefined ? Boolean(is_active) : true]
    );

    return res.status(201).json({ success: true, category: result.rows[0] });
  } catch (error) {
    console.error('Error creating storage category:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A storage category with this name already exists' });
    }
    return res.status(500).json({ error: 'Failed to create storage category' });
  }
});

// ============================================
// STORAGE ITEMS API
// ============================================
app.get('/api/storage-items', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT si.*, sc.name AS category_name, b.booking_number
       FROM storage_items si
       LEFT JOIN storage_categories sc ON sc.id = si.category_id AND sc.workspace_id = si.workspace_id
       LEFT JOIN bookings b ON b.id = si.booking_id AND b.workspace_id = si.workspace_id
       WHERE si.workspace_id = $1
       ORDER BY si.created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, items: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching storage items:', error);
    return res.status(500).json({ error: 'Failed to fetch storage items' });
  }
});

app.post('/api/storage-items', requireAdmin, async (req, res) => {
  const { booking_id, category_id, name, storage_type, storage_path, size_bytes, status, notes } = req.body;

  if (!name || !storage_type || !storage_path) {
    return res.status(400).json({ error: 'Name, storage type, and storage path are required' });
  }

  try {
    if (booking_id) {
      const bookingCheck = await pool.query(
        `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
        [booking_id, req.user.workspace_id]
      );
      if (bookingCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Booking not found in this workspace' });
      }
    }

    if (category_id) {
      const categoryCheck = await pool.query(
        `SELECT id FROM storage_categories WHERE id = $1 AND workspace_id = $2`,
        [category_id, req.user.workspace_id]
      );
      if (categoryCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Storage category not found in this workspace' });
      }
    }

    const result = await pool.query(
      `INSERT INTO storage_items (workspace_id, booking_id, category_id, name, storage_type, storage_path, size_bytes, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.workspace_id, booking_id || null, category_id || null, String(name).trim(), storage_type, String(storage_path).trim(), size_bytes !== undefined && size_bytes !== null ? Number(size_bytes) : null, status || 'active', notes?.trim() || null]
    );

    return res.status(201).json({ success: true, item: result.rows[0] });
  } catch (error) {
    console.error('Error creating storage item:', error);
    return res.status(500).json({ error: 'Failed to create storage item' });
  }
});

// ============================================
// WORKFLOWS API
// ============================================
app.get('/api/workflows', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM workflows WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, workflows: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching workflows:', error);
    return res.status(500).json({ error: 'Failed to fetch workflows' });
  }
});

app.post('/api/workflows', requireAdmin, async (req, res) => {
  const { name, description, is_active } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Workflow name is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO workflows (workspace_id, name, description, is_active)
       VALUES ($1, $2, $3, $4)
       RETURNING *`,
      [req.user.workspace_id, String(name).trim(), description?.trim() || null, is_active !== undefined ? Boolean(is_active) : true]
    );

    return res.status(201).json({ success: true, workflow: result.rows[0] });
  } catch (error) {
    console.error('Error creating workflow:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A workflow with this name already exists' });
    }
    return res.status(500).json({ error: 'Failed to create workflow' });
  }
});

// ============================================
// WORKFLOW STEPS API
// ============================================
app.get('/api/workflow-steps', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ws.*, w.name AS workflow_name
       FROM workflow_steps ws
       JOIN workflows w ON w.id = ws.workflow_id AND w.workspace_id = $1
       WHERE w.workspace_id = $1
       ORDER BY ws.step_order ASC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, workflowSteps: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching workflow steps:', error);
    return res.status(500).json({ error: 'Failed to fetch workflow steps' });
  }
});

app.post('/api/workflow-steps', requireAdmin, async (req, res) => {
  const { workflow_id, name, description, step_order, status } = req.body;

  if (!workflow_id || !name || !step_order) {
    return res.status(400).json({ error: 'Workflow, name, and step order are required' });
  }

  try {
    const workflowCheck = await pool.query(
      `SELECT id FROM workflows WHERE id = $1 AND workspace_id = $2`,
      [workflow_id, req.user.workspace_id]
    );
    if (workflowCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Workflow not found in this workspace' });
    }

    const result = await pool.query(
      `INSERT INTO workflow_steps (workflow_id, name, description, step_order, status)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [workflow_id, String(name).trim(), description?.trim() || null, Number(step_order), status || 'active']
    );

    return res.status(201).json({ success: true, workflowStep: result.rows[0] });
  } catch (error) {
    console.error('Error creating workflow step:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Step order already exists for this workflow' });
    }
    return res.status(500).json({ error: 'Failed to create workflow step' });
  }
});

// ============================================
// BOARDS API
// ============================================
app.get('/api/boards', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM boards WHERE workspace_id = $1 ORDER BY created_at DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, boards: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching boards:', error);
    return res.status(500).json({ error: 'Failed to fetch boards' });
  }
});

app.post('/api/boards', requireAdmin, async (req, res) => {
  const { name, description, board_type, is_active } = req.body;

  if (!name) {
    return res.status(400).json({ error: 'Board name is required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO boards (workspace_id, name, description, board_type, is_active)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [req.user.workspace_id, String(name).trim(), description?.trim() || null, board_type || 'general', is_active !== undefined ? Boolean(is_active) : true]
    );

    return res.status(201).json({ success: true, board: result.rows[0] });
  } catch (error) {
    console.error('Error creating board:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A board with this name already exists' });
    }
    return res.status(500).json({ error: 'Failed to create board' });
  }
});

// ============================================
// BOARD COLUMNS API
// ============================================
app.get('/api/board-columns', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT bc.*, b.name AS board_name
       FROM board_columns bc
       JOIN boards b ON b.id = bc.board_id AND b.workspace_id = $1
       WHERE b.workspace_id = $1
       ORDER BY bc.column_order ASC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, boardColumns: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching board columns:', error);
    return res.status(500).json({ error: 'Failed to fetch board columns' });
  }
});

app.post('/api/board-columns', requireAdmin, async (req, res) => {
  const { board_id, name, description, column_order, color } = req.body;

  if (!board_id || !name || !column_order) {
    return res.status(400).json({ error: 'Board, name, and column order are required' });
  }

  try {
    const boardCheck = await pool.query(
      `SELECT id FROM boards WHERE id = $1 AND workspace_id = $2`,
      [board_id, req.user.workspace_id]
    );
    if (boardCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Board not found in this workspace' });
    }

    const result = await pool.query(
      `INSERT INTO board_columns (board_id, name, description, column_order, color)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING *`,
      [board_id, String(name).trim(), description?.trim() || null, Number(column_order), color?.trim() || null]
    );

    return res.status(201).json({ success: true, boardColumn: result.rows[0] });
  } catch (error) {
    console.error('Error creating board column:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'Board column order or name already exists for this board' });
    }
    return res.status(500).json({ error: 'Failed to create board column' });
  }
});

// ============================================
// DASHBOARD / ANALYTICS API
// ============================================
app.get('/api/dashboard/summary', async (req, res) => {
  try {
    const stats = await pool.query(
      `WITH booking_stats AS (
         SELECT
           COUNT(*)::int AS total_bookings,
           COUNT(*) FILTER (WHERE status NOT IN ('cancelled', 'completed'))::int AS active_bookings,
           COALESCE(SUM(total_amount), 0)::numeric AS booking_value
         FROM bookings
         WHERE workspace_id = $1
       ),
       payment_stats AS (
         SELECT
           COALESCE(SUM(amount), 0)::numeric AS paid_revenue
         FROM payments
         WHERE workspace_id = $1 AND status = 'completed'
       ),
       invoice_stats AS (
         SELECT
           COALESCE(SUM(CASE WHEN status != 'paid' THEN total_amount ELSE 0 END), 0)::numeric AS outstanding_value,
           COUNT(*) FILTER (WHERE status != 'paid')::int AS outstanding_invoices
         FROM invoices
         WHERE workspace_id = $1
       ),
       job_stats AS (
         SELECT
           COUNT(*)::int AS total_jobs,
           COUNT(*) FILTER (WHERE status IN ('pending', 'in_progress', 'queued'))::int AS active_jobs,
           COUNT(*) FILTER (WHERE status = 'completed')::int AS completed_jobs
         FROM production_jobs
         WHERE workspace_id = $1
       ),
       review_stats AS (
         SELECT
           COUNT(*)::int AS total_reviews,
           COUNT(*) FILTER (WHERE review_status = 'pending')::int AS pending_reviews,
           COUNT(*) FILTER (WHERE review_status = 'completed')::int AS completed_reviews,
           COUNT(*) FILTER (WHERE review_status = 'overdue')::int AS overdue_reviews
         FROM client_reviews
         WHERE workspace_id = $1
       ),
       event_stats AS (
         SELECT
           COUNT(*)::int AS upcoming_events,
           COUNT(*) FILTER (WHERE (SELECT COUNT(*) FROM crew_assignments ca WHERE ca.booking_event_id = be.id) = 0)::int AS unassigned_crew_events
         FROM booking_events be
         WHERE be.workspace_id = $1 AND be.event_date >= CURRENT_DATE
       )
       SELECT
         bs.total_bookings,
         bs.active_bookings,
         bs.booking_value,
         ps.paid_revenue,
         is_.outstanding_value,
         is_.outstanding_invoices,
         js.total_jobs,
         js.active_jobs,
         js.completed_jobs,
         rs.total_reviews,
         rs.pending_reviews,
         rs.completed_reviews,
         rs.overdue_reviews,
         es.upcoming_events,
         es.unassigned_crew_events
       FROM booking_stats bs
       CROSS JOIN payment_stats ps
       CROSS JOIN invoice_stats is_
       CROSS JOIN job_stats js
       CROSS JOIN review_stats rs
       CROSS JOIN event_stats es;`,
      [req.user.workspace_id]
    );

    const unassignedEvents = await pool.query(
      `SELECT be.id AS event_id, be.booking_id, be.event_name, be.event_date, be.venue,
              c.name AS client_name, (be.event_date - CURRENT_DATE) AS days_diff
       FROM booking_events be
       JOIN bookings b ON b.id = be.booking_id AND b.workspace_id = be.workspace_id
       JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       WHERE be.workspace_id = $1
         AND (SELECT COUNT(*) FROM crew_assignments ca WHERE ca.booking_event_id = be.id) = 0
       ORDER BY be.event_date ASC
       LIMIT 10`,
      [req.user.workspace_id]
    );

    const pendingInvoices = await pool.query(
      `SELECT i.id AS invoice_id, i.booking_id, i.invoice_number, i.total_amount, i.due_date, i.status,
              c.name AS client_name
       FROM invoices i
       JOIN bookings b ON b.id = i.booking_id AND b.workspace_id = i.workspace_id
       JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       WHERE i.workspace_id = $1 AND i.status != 'paid'
       ORDER BY i.due_date ASC NULLS LAST, i.created_at DESC
       LIMIT 10`,
      [req.user.workspace_id]
    );

    const recentBookings = await pool.query(
      `SELECT b.id, b.booking_number, b.status, b.total_amount, c.name AS client_name, b.booking_date
       FROM bookings b
       JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       WHERE b.workspace_id = $1
       ORDER BY b.booking_date DESC, b.created_at DESC
       LIMIT 5`,
      [req.user.workspace_id]
    );

    const recentJobs = await pool.query(
      `SELECT pj.id, pj.job_name, pj.status, pj.priority, c.name AS client_name, pj.due_date
       FROM production_jobs pj
       JOIN bookings b ON b.id = pj.booking_id AND b.workspace_id = pj.workspace_id
       JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       WHERE pj.workspace_id = $1
       ORDER BY pj.due_date ASC NULLS LAST, pj.created_at DESC
       LIMIT 5`,
      [req.user.workspace_id]
    );

    const dashboard = stats.rows[0] || {};

    return res.json({
      success: true,
      summary: {
        totalBookings: Number(dashboard.total_bookings || 0),
        activeBookings: Number(dashboard.active_bookings || 0),
        bookingValue: Number(dashboard.booking_value || 0),
        paidRevenue: Number(dashboard.paid_revenue || 0),
        outstandingValue: Number(dashboard.outstanding_value || 0),
        outstandingInvoices: Number(dashboard.outstanding_invoices || 0),
        totalJobs: Number(dashboard.total_jobs || 0),
        activeJobs: Number(dashboard.active_jobs || 0),
        completedJobs: Number(dashboard.completed_jobs || 0),
        totalReviews: Number(dashboard.total_reviews || 0),
        pendingReviews: Number(dashboard.pending_reviews || 0),
        completedReviews: Number(dashboard.completed_reviews || 0),
        overdueReviews: Number(dashboard.overdue_reviews || 0),
        upcomingEvents: Number(dashboard.upcoming_events || 0),
        unassignedCrewEvents: Number(dashboard.unassigned_crew_events || 0),
      },
      unassignedEvents: unassignedEvents.rows,
      pendingInvoices: pendingInvoices.rows,
      recentBookings: recentBookings.rows,
      recentJobs: recentJobs.rows,
    });
  } catch (error) {
    console.error('Error fetching dashboard summary:', error);
    return res.status(500).json({ error: 'Failed to fetch dashboard summary' });
  }
});

app.get('/api/dashboard/calendar', async (req, res) => {
  try {
    const year = parseInt(req.query.year, 10) || new Date().getFullYear();
    const month = parseInt(req.query.month, 10) || (new Date().getMonth() + 1);

    const startDate = `${year}-${String(month).padStart(2, '0')}-01`;
    const endDate = new Date(year, month, 0).toISOString().slice(0, 10);

    const result = await pool.query(
      `SELECT be.id, be.booking_id, be.event_name, be.event_date, be.venue,
              c.name AS client_name, p.name AS package_name,
              (SELECT COUNT(*) FROM crew_assignments ca WHERE ca.booking_event_id = be.id) AS crew_count
       FROM booking_events be
       JOIN bookings b ON b.id = be.booking_id AND b.workspace_id = be.workspace_id
       JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       LEFT JOIN packages p ON p.id = b.package_id AND p.workspace_id = b.workspace_id
       WHERE be.workspace_id = $1
         AND be.event_date >= $2 AND be.event_date <= $3
       ORDER BY be.event_date ASC`,
      [req.user.workspace_id, startDate, endDate]
    );

    const events = result.rows.map(row => ({
      id: row.id,
      bookingId: row.booking_id,
      name: row.client_name || row.event_name,
      eventName: row.event_name,
      location: row.venue || 'N/A',
      packageName: row.package_name || 'Standard Package',
      eventDate: row.event_date,
      needsCrew: Number(row.crew_count) === 0
    }));

    return res.json({ success: true, events, year, month });
  } catch (error) {
    console.error('Error fetching dashboard calendar:', error);
    return res.status(500).json({ error: 'Failed to fetch dashboard calendar' });
  }
});

// ============================================
// CREW ASSIGNMENTS API
// ============================================
app.get('/api/crew-assignments', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ca.*, u.staff_name AS staff_name, u.email AS staff_email, u.phone_number AS staff_phone,
              be.event_name, be.event_date, be.venue,
              b.booking_number, c.name AS client_name
       FROM crew_assignments ca
       JOIN users u ON u.id = ca.staff_id AND u.workspace_id = ca.workspace_id
       JOIN booking_events be ON be.id = ca.booking_event_id AND be.workspace_id = ca.workspace_id
       JOIN bookings b ON b.id = be.booking_id AND b.workspace_id = ca.workspace_id
       JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       WHERE ca.workspace_id = $1
       ORDER BY be.event_date ASC, ca.assignment_date DESC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, crewAssignments: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching crew assignments:', error);
    return res.status(500).json({ error: 'Failed to fetch crew assignments' });
  }
});

app.post('/api/crew-assignments', async (req, res) => {
  const { booking_event_id, staff_id, assigned_role, assignment_date, start_time, end_time, status, notes } = req.body;

  if (!booking_event_id || !staff_id || !assigned_role) {
    return res.status(400).json({ error: 'Booking event, staff, and role are required' });
  }

  try {
    const eventCheck = await pool.query(
      `SELECT id, workspace_id FROM booking_events WHERE id = $1`,
      [booking_event_id]
    );
    if (eventCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking event not found' });
    }

    const targetWorkspaceId = req.user?.workspace_id || eventCheck.rows[0].workspace_id;

    let resolvedStaffId = staff_id;
    let staffMember = null;

    const userCheck = await pool.query(
      `SELECT id, email, COALESCE(staff_name, first_name || ' ' || last_name, email) AS staff_name FROM users WHERE id = $1`,
      [staff_id]
    );

    if (userCheck.rows.length > 0) {
      staffMember = userCheck.rows[0];
    } else {
      const staffTableCheck = await pool.query(
        `SELECT id, email, name AS staff_name, user_id FROM staff WHERE id = $1 OR user_id = $1`,
        [staff_id]
      );
      if (staffTableCheck.rows.length > 0) {
        staffMember = staffTableCheck.rows[0];
        if (staffMember.user_id) {
          resolvedStaffId = staffMember.user_id;
        }
      }
    }

    if (!staffMember) {
      return res.status(400).json({ error: 'Staff member not found' });
    }

    const result = await pool.query(
      `INSERT INTO crew_assignments (workspace_id, booking_event_id, staff_id, assigned_role, assignment_date, start_time, end_time, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [targetWorkspaceId, booking_event_id, resolvedStaffId, String(assigned_role).trim(), assignment_date || new Date().toISOString().slice(0, 10), start_time || null, end_time || null, status || 'assigned', notes?.trim() || null]
    );

    const insertedAssignment = result.rows[0];

    const fullAssignmentDetails = await pool.query(
      `SELECT ca.*, COALESCE(u.staff_name, u.first_name || ' ' || u.last_name, u.email) AS staff_name, u.email AS staff_email, u.phone_number AS staff_phone,
              be.event_name, be.event_date, be.venue,
              b.booking_number, c.name AS client_name
       FROM crew_assignments ca
       LEFT JOIN users u ON u.id = ca.staff_id
       LEFT JOIN booking_events be ON be.id = ca.booking_event_id
       LEFT JOIN bookings b ON b.id = be.booking_id
       LEFT JOIN client c ON c.id = b.client_id
       WHERE ca.id = $1`,
      [insertedAssignment.id]
    );

    const crewAssignment = fullAssignmentDetails.rows[0] || insertedAssignment;

    // Fetch event details for email notification
    const eventDetails = await pool.query(
      `SELECT be.event_name, be.event_date, be.venue, b.booking_number, c.name AS client_name
       FROM booking_events be
       LEFT JOIN bookings b ON b.id = be.booking_id
       LEFT JOIN client c ON c.id = b.client_id
       WHERE be.id = $1`,
      [booking_event_id]
    );

    if (eventDetails.rows.length > 0 && staffMember.email) {
      const event = eventDetails.rows[0];
      try {
        await sendCrewAssignmentEmail(
          staffMember.email,
          staffMember.staff_name || 'Team Member',
          event.client_name,
          event.event_name,
          event.event_date,
          event.venue,
          assigned_role
        );
        console.log('Crew assignment email sent successfully');
      } catch (emailError) {
        console.error('Failed to send crew assignment email:', emailError);
        // Don't fail the assignment if email fails
      }
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'crew_assignment_created',
      description: `Created crew assignment for staff ${resolvedStaffId} to event ${booking_event_id}`,
      req,
      workspaceId: targetWorkspaceId,
    });

    return res.status(201).json({ success: true, crewAssignment });
  } catch (error) {
    console.error('Error creating crew assignment:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This staff member is already assigned to this event' });
    }
    return res.status(500).json({ error: error.message || 'Failed to create crew assignment' });
  }
});

app.get('/api/crew-assignments/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT ca.*, u.staff_name AS staff_name, u.email AS staff_email, u.phone_number AS staff_phone,
              be.event_name, be.event_date, be.venue,
              b.booking_number, c.name AS client_name
       FROM crew_assignments ca
       JOIN users u ON u.id = ca.staff_id AND u.workspace_id = ca.workspace_id
       JOIN booking_events be ON be.id = ca.booking_event_id AND be.workspace_id = ca.workspace_id
       JOIN bookings b ON b.id = be.booking_id AND b.workspace_id = ca.workspace_id
       JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       WHERE ca.id = $1 AND ca.workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Crew assignment not found' });
    }

    return res.json({ success: true, crewAssignment: result.rows[0] });
  } catch (error) {
    console.error('Error fetching crew assignment:', error);
    return res.status(500).json({ error: 'Failed to fetch crew assignment' });
  }
});

app.put('/api/crew-assignments/:id', async (req, res) => {
  const { booking_event_id, staff_id, assigned_role, assignment_date, start_time, end_time, status, notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE crew_assignments
       SET booking_event_id = COALESCE($1, booking_event_id),
           staff_id = COALESCE($2, staff_id),
           assigned_role = COALESCE($3, assigned_role),
           assignment_date = COALESCE($4, assignment_date),
           start_time = $5,
           end_time = $6,
           status = COALESCE($7, status),
           notes = $8,
           updated_at = NOW()
       WHERE id = $9 AND workspace_id = $10
       RETURNING *`,
      [booking_event_id || null, staff_id || null, assigned_role?.trim() || null, assignment_date || null, start_time || null, end_time || null, status || null, notes?.trim() || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Crew assignment not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'crew_assignment_updated',
      description: `Updated crew assignment ${req.params.id}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, crewAssignment: result.rows[0] });
  } catch (error) {
    console.error('Error updating crew assignment:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'This staff member is already assigned to this event' });
    }
    return res.status(500).json({ error: 'Failed to update crew assignment' });
  }
});

app.delete('/api/crew-assignments/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM crew_assignments
       WHERE id = $1 AND workspace_id = $2
       RETURNING id`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Crew assignment not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'crew_assignment_deleted',
      description: `Deleted crew assignment ${req.params.id}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, message: 'Crew assignment deleted successfully' });
  } catch (error) {
    console.error('Error deleting crew assignment:', error);
    return res.status(500).json({ error: 'Failed to delete crew assignment' });
  }
});

// ============================================
// PRODUCTION TICKETS API
// ============================================

app.get('/api/production-tickets', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pt.*, 
              u.staff_name AS assignee_name, u.email AS assignee_email,
              b.booking_number, c.name AS client_name,
              COALESCE(es.level, 1) as escalation_level,
              COALESCE(es.role, 'HR') as escalation_role
       FROM production_tickets pt
       LEFT JOIN users u ON u.id = pt.assignee_id AND u.workspace_id = pt.workspace_id
       LEFT JOIN bookings b ON b.id = pt.booking_id AND b.workspace_id = pt.workspace_id
       LEFT JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       LEFT JOIN escalation_matrix es ON es.workspace_id = pt.workspace_id AND es.level = COALESCE(pt.escalation_level, 1)
       WHERE pt.workspace_id = $1
       ORDER BY pt.deadline ASC, pt.created_at DESC`,
      [req.user.workspace_id]
    );

    // Calculate overdue status and escalation for each ticket
    const tickets = [];
    const escalationMatrixRes = await pool.query(
      `SELECT level, overdue_hours, role FROM escalation_matrix 
       WHERE workspace_id = $1 
       ORDER BY overdue_hours ASC`,
      [req.user.workspace_id]
    );
    const escalationMatrix = escalationMatrixRes.rows;

    for (const ticket of result.rows) {
      const deadline = new Date(ticket.deadline);
      const now = new Date();
      const isOverdue = deadline < now;
      
      let escalationLevel = ticket.escalation_level;
      let escalationRole = ticket.escalation_role;
      
      if (isOverdue && !ticket.is_acknowledged && !escalationLevel && escalationMatrix.length > 0) {
        const overdueHours = Math.floor((now.getTime() - deadline.getTime()) / (1000 * 60 * 60));
        
        for (const level of escalationMatrix) {
          if (overdueHours >= level.overdue_hours) {
            escalationLevel = level.level;
            escalationRole = level.role;
          }
        }
        
        if (escalationLevel) {
          await pool.query(
            `UPDATE production_tickets 
             SET is_overdue = true, escalation_level = $1, escalation_role = $2, updated_at = NOW()
             WHERE id = $3 AND workspace_id = $4`,
            [escalationLevel, escalationRole, ticket.id, req.user.workspace_id]
          );
        }
      }

      tickets.push({
        ...ticket,
        is_overdue: isOverdue || ticket.is_overdue,
        escalation_level: escalationLevel,
        escalation_role: escalationRole,
        is_acknowledged: !!ticket.is_acknowledged
      });
    }

    return res.json({ success: true, tickets, count: tickets.length });
  } catch (error) {
    console.error('Error fetching production tickets:', error);
    return res.status(500).json({ error: 'Failed to fetch production tickets' });
  }
});

app.get('/api/production-tickets/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT pt.*, 
              u.staff_name AS assignee_name, u.email AS assignee_email,
              b.booking_number, c.name AS client_name
       FROM production_tickets pt
       LEFT JOIN users u ON u.id = pt.assignee_id AND u.workspace_id = pt.workspace_id
       LEFT JOIN bookings b ON b.id = pt.booking_id AND b.workspace_id = pt.workspace_id
       LEFT JOIN client c ON c.id = b.client_id AND c.workspace_id = b.workspace_id
       WHERE pt.id = $1 AND pt.workspace_id = $2`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Production ticket not found' });
    }

    return res.json({ success: true, ticket: result.rows[0] });
  } catch (error) {
    console.error('Error fetching production ticket:', error);
    return res.status(500).json({ error: 'Failed to fetch production ticket' });
  }
});

app.post('/api/production-tickets', async (req, res) => {
  const { booking_id, title, description, category, priority, assignee_id, deadline, material_note } = req.body;

  if (!title || !category || !deadline) {
    return res.status(400).json({ error: 'Title, category, and deadline are required' });
  }

  try {
    if (booking_id) {
      const bookingCheck = await pool.query(
        `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
        [booking_id, req.user.workspace_id]
      );
      if (bookingCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Booking not found in this workspace' });
      }
    }

    if (assignee_id) {
      const assigneeCheck = await pool.query(
        `SELECT id FROM users WHERE id = $1 AND workspace_id = $2`,
        [assignee_id, req.user.workspace_id]
      );
      if (assigneeCheck.rows.length === 0) {
        return res.status(400).json({ error: 'Assignee not found in this workspace' });
      }
    }

    const result = await pool.query(
      `INSERT INTO production_tickets (workspace_id, booking_id, title, description, category, priority, assignee_id, deadline, material_note)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.workspace_id, booking_id || null, title, description || null, category, priority || 'normal', assignee_id || null, deadline, material_note || null]
    );

    await logUserActivity({
      userId: req.user.id,
      action: 'production_ticket_created',
      description: `Created production ticket: ${title}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.status(201).json({ success: true, ticket: result.rows[0] });
  } catch (error) {
    console.error('Error creating production ticket:', error);
    return res.status(500).json({ error: 'Failed to create production ticket' });
  }
});

app.put('/api/production-tickets/:id', async (req, res) => {
  const { booking_id, title, description, category, status, priority, assignee_id, deadline, material_note, completion_notes } = req.body;

  try {
    const result = await pool.query(
      `UPDATE production_tickets
       SET booking_id = COALESCE($1, booking_id),
           title = COALESCE($2, title),
           description = COALESCE($3, description),
           category = COALESCE($4, category),
           status = COALESCE($5, status),
           priority = COALESCE($6, priority),
           assignee_id = COALESCE($7, assignee_id),
           deadline = COALESCE($8, deadline),
           material_note = COALESCE($9, material_note),
           completion_notes = COALESCE($10, completion_notes),
           updated_at = NOW()
       WHERE id = $11 AND workspace_id = $12
       RETURNING *`,
      [booking_id || null, title || null, description || null, category || null, status || null, priority || null, assignee_id || null, deadline || null, material_note || null, completion_notes || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Production ticket not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'production_ticket_updated',
      description: `Updated production ticket ${req.params.id}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, ticket: result.rows[0] });
  } catch (error) {
    console.error('Error updating production ticket:', error);
    return res.status(500).json({ error: 'Failed to update production ticket' });
  }
});

app.delete('/api/production-tickets/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM production_tickets
       WHERE id = $1 AND workspace_id = $2
       RETURNING id`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Production ticket not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'production_ticket_deleted',
      description: `Deleted production ticket ${req.params.id}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, message: 'Production ticket deleted successfully' });
  } catch (error) {
    console.error('Error deleting production ticket:', error);
    return res.status(500).json({ error: 'Failed to delete production ticket' });
  }
});

// Acknowledge escalation (set is_acknowledged = true)
app.post('/api/production-tickets/:id/acknowledge', async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE production_tickets
       SET is_acknowledged = true, updated_at = NOW()
       WHERE id = $1 AND workspace_id = $2
       RETURNING *`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Production ticket not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'production_ticket_escalation_acknowledged',
      description: `Acknowledged escalation for ticket ${req.params.id}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, ticket: result.rows[0] });
  } catch (error) {
    console.error('Error acknowledging escalation:', error);
    return res.status(500).json({ error: 'Failed to acknowledge escalation' });
  }
});

// File upload endpoints for production tickets
app.post('/api/production-tickets/:id/source-files', upload.array('sourceFiles', 5), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ticket exists in workspace
    const ticketCheck = await pool.query(
      'SELECT id FROM production_tickets WHERE id = $1 AND workspace_id = $2',
      [id, req.user.workspace_id]
    );
    
    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Production ticket not found' });
    }

    const uploadedFiles = req.files.map(file => ({
      filename: file.filename,
      originalname: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      uploadDate: new Date()
    }));

    return res.json({
      success: true,
      files: uploadedFiles,
      message: 'Source files uploaded successfully'
    });
  } catch (error) {
    console.error('Error uploading source files:', error);
    return res.status(500).json({ error: 'Failed to upload source files' });
  }
});

app.post('/api/production-tickets/:id/output-files', upload.array('outputFiles', 5), async (req, res) => {
  try {
    const { id } = req.params;
    
    // Validate ticket exists in workspace
    const ticketCheck = await pool.query(
      'SELECT id FROM production_tickets WHERE id = $1 AND workspace_id = $2',
      [id, req.user.workspace_id]
    );
    
    if (ticketCheck.rows.length === 0) {
      return res.status(404).json({ error: 'Production ticket not found' });
    }

    const uploadedFiles = req.files.map(file => ({
      filename: file.filename,
      originalname: file.originalname,
      size: file.size,
      mimetype: file.mimetype,
      uploadDate: new Date()
    }));

    return res.json({
      success: true,
      files: uploadedFiles,
      message: 'Output files uploaded successfully'
    });
  } catch (error) {
    console.error('Error uploading output files:', error);
    return res.status(500).json({ error: 'Failed to upload output files' });
  }
});

// Escalation Matrix endpoints
app.get('/api/escalation-matrix', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM escalation_matrix
       WHERE workspace_id = $1
       ORDER BY level ASC`,
      [req.user.workspace_id]
    );

    return res.json({ success: true, escalationMatrix: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching escalation matrix:', error);
    return res.status(500).json({ error: 'Failed to fetch escalation matrix' });
  }
});

app.post('/api/escalation-matrix', async (req, res) => {
  const { level, overdue_hours, role, priority } = req.body;

  if (!level || !overdue_hours || !role) {
    return res.status(400).json({ error: 'Level, overdue hours, and role are required' });
  }

  try {
    const result = await pool.query(
      `INSERT INTO escalation_matrix (workspace_id, level, overdue_hours, role, priority)
       VALUES ($1, $2, $3, $4, $5)
       ON CONFLICT (workspace_id, level) 
       DO UPDATE SET overdue_hours = $3, role = $4, priority = $5, updated_at = NOW()
       RETURNING *`,
      [req.user.workspace_id, level, overdue_hours, role, priority || 'Normal']
    );

    return res.status(201).json({ success: true, escalationMatrix: result.rows[0] });
  } catch (error) {
    console.error('Error saving escalation matrix:', error);
    return res.status(500).json({ error: 'Failed to save escalation matrix' });
  }
});

// ============================================
// REMINDERS API
// ============================================

app.get('/api/reminders/:bookingId', async (req, res) => {
  try {
    const result = await pool.query(
      `SELECT * FROM reminders
       WHERE booking_id = $1 AND workspace_id = $2
       ORDER BY scheduled_date ASC, scheduled_time ASC`,
      [req.params.bookingId, req.user.workspace_id]
    );

    return res.json({ success: true, reminders: result.rows, count: result.rows.length });
  } catch (error) {
    console.error('Error fetching reminders:', error);
    return res.status(500).json({ error: 'Failed to fetch reminders' });
  }
});

app.post('/api/reminders', async (req, res) => {
  const { booking_id, reminder_type, days_before_event, scheduled_date, scheduled_time, recipient_email, subject, message_content } = req.body;

  if (!booking_id || !reminder_type || !days_before_event || !scheduled_date || !recipient_email) {
    return res.status(400).json({ error: 'Booking ID, reminder type, days before event, scheduled date, and recipient email are required' });
  }

  try {
    const bookingCheck = await pool.query(
      `SELECT id FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [booking_id, req.user.workspace_id]
    );
    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found in this workspace' });
    }

    const result = await pool.query(
      `INSERT INTO reminders (workspace_id, booking_id, reminder_type, days_before_event, scheduled_date, scheduled_time, recipient_email, subject, message_content, status)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9, 'pending')
       RETURNING *`,
      [req.user.workspace_id, booking_id, reminder_type, days_before_event, scheduled_date, scheduled_time || null, recipient_email, subject || null, message_content || null]
    );

    await logUserActivity({
      userId: req.user.id,
      action: 'reminder_created',
      description: `Created reminder for booking ${booking_id}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.status(201).json({ success: true, reminder: result.rows[0] });
  } catch (error) {
    console.error('Error creating reminder:', error);
    if (error.code === '23505') {
      return res.status(409).json({ error: 'A reminder with these parameters already exists' });
    }
    return res.status(500).json({ error: 'Failed to create reminder' });
  }
});

app.put('/api/reminders/:id', async (req, res) => {
  const { reminder_type, days_before_event, scheduled_date, scheduled_time, recipient_email, subject, message_content, status } = req.body;

  try {
    const result = await pool.query(
      `UPDATE reminders
       SET reminder_type = COALESCE($1, reminder_type),
           days_before_event = COALESCE($2, days_before_event),
           scheduled_date = COALESCE($3, scheduled_date),
           scheduled_time = $4,
           recipient_email = COALESCE($5, recipient_email),
           subject = $6,
           message_content = $7,
           status = COALESCE($8, status),
           updated_at = NOW()
       WHERE id = $9 AND workspace_id = $10
       RETURNING *`,
      [reminder_type || null, days_before_event || null, scheduled_date || null, scheduled_time || null, recipient_email || null, subject || null, message_content || null, status || null, req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reminder not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'reminder_updated',
      description: `Updated reminder ${req.params.id}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, reminder: result.rows[0] });
  } catch (error) {
    console.error('Error updating reminder:', error);
    return res.status(500).json({ error: 'Failed to update reminder' });
  }
});

app.delete('/api/reminders/:id', async (req, res) => {
  try {
    const result = await pool.query(
      `DELETE FROM reminders
       WHERE id = $1 AND workspace_id = $2
       RETURNING id`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'Reminder not found' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'reminder_deleted',
      description: `Deleted reminder ${req.params.id}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, message: 'Reminder deleted successfully' });
  } catch (error) {
    console.error('Error deleting reminder:', error);
    return res.status(500).json({ error: 'Failed to delete reminder' });
  }
});

// ============================================
// REMINDER AUTOMATION SYSTEM
// ============================================

// Check for due reminders and send emails
async function processDueReminders() {
  try {
    console.log('Checking for due reminders...');
    
    const now = new Date();
    const currentIST = new Date(now.getTime() + (5.5 * 60 * 60 * 1000)); // IST = UTC+5:30
    const currentDateStr = currentIST.toISOString().split('T')[0];
    const currentTimeStr = currentIST.toTimeString().split(' ')[0].substring(0, 5);
    
    console.log(`Current IST time: ${currentDateStr} ${currentTimeStr}`);

    // Find reminders that are due (scheduled date/time has passed) and are still pending
    // Convert stored date to string format for comparison
    const dueReminders = await pool.query(
      `SELECT r.*, b.booking_number, c.name as client_name,
       TO_CHAR(r.scheduled_date, 'YYYY-MM-DD') as scheduled_date_str
       FROM reminders r
       JOIN bookings b ON b.id = r.booking_id
       JOIN client c ON c.id = b.client_id
       WHERE r.status = 'pending'
       AND TO_CHAR(r.scheduled_date, 'YYYY-MM-DD') <= $1
       AND (r.scheduled_time IS NULL OR r.scheduled_time <= $2)
       ORDER BY r.scheduled_date, r.scheduled_time`,
      [currentDateStr, currentTimeStr]
    );

    console.log(`Found ${dueReminders.rows.length} due reminders`);

    for (const reminder of dueReminders.rows) {
      try {
        console.log(`Processing reminder: ${reminder.reminder_type} for booking ${reminder.booking_number}`);
        console.log(`Scheduled date: ${reminder.scheduled_date_str}, time: ${reminder.scheduled_time}`);
        console.log(`Recipient: ${reminder.recipient_email}`);
        
        // Send the reminder email
        await sendReminderEmail(
          reminder.recipient_email,
          reminder.subject,
          reminder.message_content,
          reminder.reminder_type,
          reminder.days_before_event
        );

        // Update reminder status to sent
        await pool.query(
          `UPDATE reminders 
           SET status = 'sent', 
               sent_date = NOW(), 
               updated_at = NOW()
           WHERE id = $1`,
          [reminder.id]
        );

        console.log(`✅ Successfully sent reminder ${reminder.id}`);

      } catch (error) {
        console.error(`❌ Failed to send reminder ${reminder.id}:`, error.message);
        
        // Update reminder status to failed
        await pool.query(
          `UPDATE reminders 
           SET status = 'failed', 
               error_message = $1,
               updated_at = NOW()
           WHERE id = $2`,
          [error.message, reminder.id]
        );
      }
    }

  } catch (error) {
    console.error('Error processing due reminders:', error);
  }
}

// Start the reminder automation system
function startReminderAutomation() {
  console.log('Starting reminder automation system...');
  
  // Run immediately on startup
  processDueReminders();
  
  // Run every minute (60,000ms)
  setInterval(processDueReminders, 60 * 1000);
  
  console.log('Reminder automation system started - checking every minute');
}

// Start the automation after server starts
setTimeout(startReminderAutomation, 5000);

// ============================================
// STORAGE ENHANCED API
// ============================================

// Get storage statistics
app.get('/api/storage/stats', async (req, res) => {
  try {
    if (!req.user?.workspace_id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const workspaceId = req.user.workspace_id;

    // Get total storage usage
    const sizeResult = await pool.query(
      `SELECT COALESCE(SUM(file_size), 0) as total_size, COUNT(*) as file_count
       FROM files
       WHERE workspace_id = $1 AND status != 'deleted'`,
      [workspaceId]
    );

    const totalSize = parseInt(sizeResult.rows[0].total_size) || 0;
    const fileCount = parseInt(sizeResult.rows[0].file_count) || 0;

    // Format sizes
    const formatBytes = (bytes) => {
      if (bytes === 0) return '0 B';
      const k = 1024;
      const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
      const i = Math.floor(Math.log(bytes) / Math.log(k));
      return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
    };

    const totalStorageBytes = 1024 * 1024 * 1024 * 1024; // 1 TB
    const availableBytes = totalStorageBytes - totalSize;

    return res.json({
      success: true,
      usedBytes: totalSize,
      usedLabel: formatBytes(totalSize),
      uploadingLabel: '0 B',
      availableLabel: formatBytes(availableBytes),
      totalLabel: '1.00 TB',
      filesCount: fileCount,
      usagePercent: Math.max((totalSize / totalStorageBytes) * 100, 0.05)
    });
  } catch (error) {
    console.error('Error fetching storage stats:', error);
    return res.status(500).json({ error: 'Failed to fetch storage statistics' });
  }
});

// Enhanced file listing with booking information
app.get('/api/files/enhanced', async (req, res) => {
  try {
    if (!req.user?.workspace_id) {
      return res.status(401).json({ error: 'Authentication required' });
    }

    const workspaceId = req.user.workspace_id;
    const { search, category, status } = req.query;

    let query = `
      SELECT f.*, 
             b.booking_number, 
             c.name as client_name,
             COALESCE(c.name, 'Unknown') as customer_name
      FROM files f
      LEFT JOIN bookings b ON b.id = f.booking_id AND b.workspace_id = f.workspace_id
      LEFT JOIN client c ON c.id = b.client_id AND c.workspace_id = f.workspace_id
      WHERE f.workspace_id = $1 AND f.status != 'deleted'
    `;
    
    const params = [workspaceId];
    let paramCount = 1;

    if (search) {
      paramCount++;
      query += ` AND (f.file_name ILIKE $${paramCount} OR b.booking_number ILIKE $${paramCount} OR c.name ILIKE $${paramCount})`;
      params.push(`%${search}%`);
    }

    if (category && category !== 'all') {
      paramCount++;
      query += ` AND f.category = $${paramCount}`;
      params.push(category);
    }

    if (status) {
      paramCount++;
      query += ` AND f.status = $${paramCount}`;
      params.push(status);
    }

    query += ` ORDER BY f.upload_date DESC`;

    const result = await pool.query(query, params);

    const files = result.rows.map(row => ({
      id: row.id,
      name: row.file_name,
      customer: row.customer_name,
      bookingId: row.booking_id,
      bookingNumber: row.booking_number,
      sizeLabel: formatBytes(row.file_size || 0),
      sizeBytes: row.file_size || 0,
      badge: row.status === 'archived' ? 'Deep Archive' : mapCategoryToBadge(row.category),
      action: row.status === 'archived' ? 'restore' : 'download',
      uploadDate: row.upload_date,
      fileType: row.file_type,
      category: row.category,
      storagePath: row.storage_path,
      status: row.status
    }));

    return res.json({ success: true, files, count: files.length });
  } catch (error) {
    console.error('Error fetching enhanced files:', error);
    return res.status(500).json({ error: 'Failed to fetch files' });
  }
});

// File upload with JSON body (simplified version - in production use multipart with actual file upload)
app.post('/api/files/upload', async (req, res) => {
  try {
    const { booking_id, file_name, file_type, category, storage_path, file_size, status, notes } = req.body;
    
    if (!booking_id || !file_name || !storage_path) {
      return res.status(400).json({ error: 'Booking, file name, and storage path are required' });
    }

    const bookingCheck = await pool.query(
      `SELECT id, booking_number FROM bookings WHERE id = $1 AND workspace_id = $2`,
      [booking_id, req.user.workspace_id]
    );
    
    if (bookingCheck.rows.length === 0) {
      return res.status(400).json({ error: 'Booking not found in this workspace' });
    }

    // In a real implementation, you would handle the actual file upload to S3/cloud storage here
    // For now, we'll just create the database record
    const result = await pool.query(
      `INSERT INTO files (workspace_id, booking_id, file_name, file_type, category, storage_path, file_size, status, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7, $8, $9)
       RETURNING *`,
      [req.user.workspace_id, booking_id, String(file_name).trim(), file_type || null, category || 'general', 
       String(storage_path).trim(), file_size !== undefined && file_size !== null ? Number(file_size) : null, 
       status || 'active', notes?.trim() || null]
    );

    await logUserActivity({
      userId: req.user.id,
      action: 'file_uploaded',
      description: `Uploaded file ${file_name} to booking ${bookingCheck.rows[0].booking_number}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.status(201).json({ success: true, file: result.rows[0] });
  } catch (error) {
    console.error('Error uploading file:', error);
    return res.status(500).json({ error: 'Failed to upload file' });
  }
});

// File download
app.get('/api/files/:id/download', async (req, res) => {
  try {
    const fileResult = await pool.query(
      `SELECT * FROM files WHERE id = $1 AND workspace_id = $2 AND status != 'deleted'`,
      [req.params.id, req.user.workspace_id]
    );

    if (fileResult.rows.length === 0) {
      return res.status(404).json({ error: 'File not found' });
    }

    const file = fileResult.rows[0];

    // In a real implementation, you would stream the file from S3/cloud storage here
    // For now, we'll return a placeholder response
    res.setHeader('Content-Type', 'application/octet-stream');
    res.setHeader('Content-Disposition', `attachment; filename="${file.file_name}"`);
    
    // Placeholder - in production, stream actual file content
    res.send('File content would be streamed from cloud storage here');

    await logUserActivity({
      userId: req.user.id,
      action: 'file_downloaded',
      description: `Downloaded file ${file.file_name}`,
      req,
      workspaceId: req.user.workspace_id,
    });
  } catch (error) {
    console.error('Error downloading file:', error);
    return res.status(500).json({ error: 'Failed to download file' });
  }
});

// Restore file from archive
app.put('/api/files/:id/restore', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE files 
       SET status = 'active', updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status = 'archived'
       RETURNING *`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found or not archived' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'file_restored',
      description: `Restored file ${result.rows[0].file_name} from archive`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, file: result.rows[0] });
  } catch (error) {
    console.error('Error restoring file:', error);
    return res.status(500).json({ error: 'Failed to restore file' });
  }
});

// Archive file
app.put('/api/files/:id/archive', requireAdmin, async (req, res) => {
  try {
    const result = await pool.query(
      `UPDATE files 
       SET status = 'archived', updated_at = now()
       WHERE id = $1 AND workspace_id = $2 AND status = 'active'
       RETURNING *`,
      [req.params.id, req.user.workspace_id]
    );

    if (result.rows.length === 0) {
      return res.status(404).json({ error: 'File not found or not active' });
    }

    await logUserActivity({
      userId: req.user.id,
      action: 'file_archived',
      description: `Archived file ${result.rows[0].file_name}`,
      req,
      workspaceId: req.user.workspace_id,
    });

    return res.json({ success: true, file: result.rows[0] });
  } catch (error) {
    console.error('Error archiving file:', error);
    return res.status(500).json({ error: 'Failed to archive file' });
  }
});

// Helper functions
function formatBytes(bytes) {
  if (bytes === 0) return '0 B';
  const k = 1024;
  const sizes = ['B', 'KB', 'MB', 'GB', 'TB'];
  const i = Math.floor(Math.log(bytes) / Math.log(k));
  return parseFloat((bytes / Math.pow(k, i)).toFixed(1)) + ' ' + sizes[i];
}

function mapCategoryToBadge(category) {
  const categoryMap = {
    'raw': 'Raw',
    'edited': 'Edited',
    'album': 'Album',
    'final': 'Final',
    'other': 'Other',
    'general': 'Other'
  };
  return categoryMap[category?.toLowerCase()] || 'Other';
}

app.listen(port, () => {
  console.log(`WedFlow CRM Backend running on port ${port}`);
  console.log(`Health check: http://localhost:${port}/api/health`);
});

pool.on('error', (err) => {
  console.error('Unexpected error on idle client', err);
  process.exit(-1);
});
