/**
 * GUMROAD WEBHOOK AUTOMATION SERVER
 * Fully automated license activation system
 */

const express = require('express');
const crypto = require('crypto');
const admin = require('firebase-admin');
const nodemailer = require('nodemailer');

// Initialize Express
const app = express();
app.use(express.json());
app.use(express.urlencoded({ extended: true }));

// ============================================================
// CONFIGURATION - SET THESE IN RENDER.COM ENVIRONMENT VARIABLES
// ============================================================

const CONFIG = {
    PORT: process.env.PORT || 3000,
    FIREBASE_PROJECT_ID: process.env.FIREBASE_PROJECT_ID || 'vision-fx-9d147',
    FIREBASE_PRIVATE_KEY: process.env.FIREBASE_PRIVATE_KEY ? 
        process.env.FIREBASE_PRIVATE_KEY.replace(/\\n/g, '\n') : '',
    FIREBASE_CLIENT_EMAIL: process.env.FIREBASE_CLIENT_EMAIL,
    
    // Email configuration
    EMAIL_SERVICE: process.env.EMAIL_SERVICE || 'gmail', // 'gmail' or 'resend'
    EMAIL_FROM: process.env.EMAIL_FROM || process.env.EMAIL_USER,
    
    // Gmail (if using Gmail)
    EMAIL_USER: process.env.EMAIL_USER,
    EMAIL_PASSWORD: process.env.EMAIL_PASSWORD,
    
    // Resend (if using Resend - recommended!)
    RESEND_API_KEY: process.env.RESEND_API_KEY,
    
    // Security
    GUMROAD_WEBHOOK_SECRET: process.env.GUMROAD_WEBHOOK_SECRET || ''
};

// Initialize Firebase Admin
try {
    admin.initializeApp({
        credential: admin.credential.cert({
            projectId: CONFIG.FIREBASE_PROJECT_ID,
            privateKey: CONFIG.FIREBASE_PRIVATE_KEY,
            clientEmail: CONFIG.FIREBASE_CLIENT_EMAIL
        })
    });
    console.log('✅ Firebase initialized');
} catch (error) {
    console.error('❌ Firebase init error:', error.message);
}

const db = admin.firestore();
const auth = admin.auth();

// Initialize Email Transporter
let transporter = null;
try {
    if (CONFIG.EMAIL_SERVICE === 'resend' && CONFIG.RESEND_API_KEY) {
        // Use Resend (recommended for transactional emails)
        transporter = nodemailer.createTransport({
            host: 'smtp.resend.com',
            port: 465,
            secure: true,
            auth: {
                user: 'resend',
                pass: CONFIG.RESEND_API_KEY
            }
        });
        console.log('✅ Email transporter initialized (Resend)');
    } else {
        // Fallback to Gmail
        transporter = nodemailer.createTransport({
            service: 'gmail',
            auth: {
                user: CONFIG.EMAIL_USER,
                pass: CONFIG.EMAIL_PASSWORD
            }
        });
        console.log('✅ Email transporter initialized (Gmail)');
    }
} catch (error) {
    console.error('❌ Email init error:', error.message);
}

// ============================================================
// TOKEN GENERATION (SAME AS YOUR Python script)
// ============================================================

function generateToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    let token = 'AT-';
    
    for (let i = 0; i < 4; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    token += '-';
    for (let i = 0; i < 4; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    token += '-';
    for (let i = 0; i < 4; i++) {
        token += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    
    return token;
}

function generatePassword() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZabcdefghijklmnopqrstuvwxyz0123456789';
    let password = '';
    for (let i = 0; i < 12; i++) {
        password += chars.charAt(Math.floor(Math.random() * chars.length));
    }
    return password;
}

/**
 * Generate activation token
 * Format: AT-XXXX-XXXX-XXXX
 */
function generateActivationToken() {
    const chars = 'ABCDEFGHIJKLMNOPQRSTUVWXYZ0123456789';
    const generateSegment = (length) => {
        let segment = '';
        for (let i = 0; i < length; i++) {
            segment += chars.charAt(Math.floor(Math.random() * chars.length));
        }
        return segment;
    };
    
    return `AT-${generateSegment(4)}-${generateSegment(4)}-${generateSegment(4)}`;
}

// ============================================================
// GUMROAD WEBHOOK VERIFICATION
// ============================================================

function verifyGumroadWebhook(body, signature) {
    if (!CONFIG.GUMROAD_WEBHOOK_SECRET) {
        console.warn('⚠️  No webhook secret configured - skipping verification');
        return true; // Allow in dev mode
    }
    
    // Gumroad doesn't sign webhooks, but you can add IP whitelist
    // For now, we'll just validate the structure
    return body && body.sale_id && body.email;
}

// ============================================================
// MAIN WEBHOOK HANDLER
// ============================================================

app.post('/webhook/gumroad', async (req, res) => {
    console.log('\n🔔 WEBHOOK RECEIVED:', new Date().toISOString());
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    try {
        // Verify webhook
        if (!verifyGumroadWebhook(req.body, req.headers['x-signature'])) {
            console.error('❌ Invalid webhook signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }
        
        // Extract purchase info
        const {
            sale_id,
            email,
            full_name,
            product_name,
            price,
            currency,
            custom_fields
        } = req.body;
        
        console.log('📧 Customer Email:', email);
        console.log('👤 Customer Name:', full_name);
        console.log('💰 Amount:', price, currency);
        
        // Extract phone number from custom fields
        const phoneNumber = custom_fields?.phone || 'none';
        
        // Check if this sale was already processed
        const existingDoc = await db.collection('purchases').doc(sale_id).get();
        if (existingDoc.exists) {
            console.log('⚠️  Sale already processed:', sale_id);
            return res.json({ 
                success: true, 
                message: 'Already processed',
                duplicate: true 
            });
        }
        
        // Generate activation token
        const activationToken = generateToken();
        console.log('🔑 Generated activation token:', activationToken);
        
        // Check if user already exists in Firebase
        let userId;
        let userPassword = null;
        let isNewAccount = false;
        
        try {
            // Try to get existing user
            const existingUser = await auth.getUserByEmail(email);
            userId = existingUser.uid;
            console.log('✅ Found existing Firebase user:', userId);
            
        } catch (error) {
            if (error.code === 'auth/user-not-found') {
                // User doesn't exist - create new account
                console.log('📝 Creating new Firebase account...');
                
                userPassword = 'Lashon2025'; // Simple default password
                
                const userRecord = await auth.createUser({
                    email: email,
                    password: userPassword,
                    displayName: full_name || email
                });
                
                userId = userRecord.uid;
                isNewAccount = true;
                
                console.log('✅ New Firebase user created:', userId);
                console.log('🔐 Default password:', userPassword);
                
                // Create user document in Firestore for new users
                await db.collection('users').doc(userId).set({
                    email: email,
                    phoneNumber: phoneNumber,
                    trialStartTime: Date.now(),
                    secondsUsed: 0,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    accountCreatedVia: 'gumroad_webhook'
                });
                console.log('✅ User document created in Firestore');
                
            } else {
                throw error;
            }
        }
        
        // Update user document with purchase info (for both new and existing users)
        // Handle missing fields gracefully
        const purchaseInfo = {
            saleId: sale_id,
            purchaseDate: new Date().toISOString(),
            phoneNumber: phoneNumber
        };
        
        // Only add fields if they exist
        if (product_name) purchaseInfo.productName = product_name;
        if (price) purchaseInfo.price = price;
        if (currency) purchaseInfo.currency = currency;
        if (full_name) purchaseInfo.customerName = full_name;
        
        await db.collection('users').doc(userId).set({
            purchaseInfo: purchaseInfo
        }, { merge: true });
        console.log('✅ Purchase info added to user document');
        
        // Store activation token in Firestore
        await db.collection('activation_tokens').doc(activationToken).set({
            email: email,
            phoneNumber: phoneNumber,
            userId: userId,
            used: false,
            licenseKey: null, // Will be set by activation program
            createdAt: admin.firestore.FieldValue.serverTimestamp(),
            expiresAt: new Date(Date.now() + 30 * 24 * 60 * 60 * 1000), // 30 days
            purchaseId: sale_id
        });
        console.log('✅ Activation token stored in Firestore');
        
        // Mark purchase as processed
        await db.collection('purchases').doc(sale_id).set({
            email: email,
            activationToken: activationToken,
            userId: userId,
            isNewAccount: isNewAccount,
            processedAt: admin.firestore.FieldValue.serverTimestamp()
        });
        
        // Send email with activation token
        if (emailTransporter) {
            let emailHtml;
            let emailSubject;
            
            if (isNewAccount) {
                // Email for NEW accounts
                emailSubject = '🎉 חשבון חדש נוצר - Hebrew Auto-Captions';
                emailHtml = `
                    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h1 style="color: #dc2626; text-align: center;">🎉 !תודה על הרכישה</h1>
                        
                        <div style="background: #dbeafe; padding: 20px; border-radius: 10px; margin: 20px 0; border-right: 4px solid #3b82f6;">
                            <h2 style="color: #1e40af; margin-top: 0;">✨ חשבון חדש נוצר עבורך!</h2>
                            <p style="color: #1e3a8a;">כיוון שזו הפעם הראשונה שלך, יצרנו עבורך חשבון חדש במערכת.</p>
                        </div>
                        
                        <div style="background: #f3f4f6; padding: 20px; border-radius: 10px; margin: 20px 0;">
                            <h2 style="color: #1f2937; margin-top: 0;">🔑 פרטי החשבון שלך:</h2>
                            
                            <div style="background: white; padding: 15px; border-radius: 8px; margin: 10px 0; font-family: 'Courier New', monospace;">
                                <p><strong>Email:</strong> ${email}</p>
                                <p><strong>Password:</strong> ${userPassword}</p>
                                <p><strong>Phone:</strong> ${phoneNumber}</p>
                            </div>
                            
                            <div style="background: #fef3c7; padding: 12px; border-radius: 8px; margin-top: 15px;">
                                <p style="color: #92400e; margin: 0; font-size: 13px;">
                                    ⚠️ <strong>חשוב:</strong> שמור פרטים אלו! תצטרך אותם להפעלת הפלאגין.
                                </p>
                            </div>
                        </div>
                        
                        <div style="background: #dcfce7; padding: 20px; border-radius: 10px; margin: 20px 0; border-right: 4px solid #22c55e;">
                            <h2 style="color: #15803d; margin-top: 0;">🎫 טוקן ההפעלה שלך:</h2>
                            
                            <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
                                <div style="font-family: 'Courier New', monospace; font-size: 28px; color: #dc2626; font-weight: 700; letter-spacing: 2px;">
                                    ${activationToken}
                                </div>
                            </div>
                            
                            <p style="color: #15803d; margin-top: 15px; font-size: 14px;">
                                טוקן זה הוא אישי ולשימוש חד-פעמי. תצטרך אותו בשלב ההפעלה.
                            </p>
                        </div>
                        
                        <div style="margin-top: 30px;">
                            <h3 style="color: #1f2937;">📋 מה לעשות עכשיו?</h3>
                            <ol style="line-height: 2; color: #374151;">
                                <li>הורד את הקבצים מ-Gumroad</li>
                                <li>התקן את הפלאגין ב-Premiere Pro</li>
                                <li>הרץ את <strong>HebrewCaptions-Activate.exe</strong></li>
                                <li>הזן את 4 הפרטים:
                                    <ul>
                                        <li>Token: ${activationToken}</li>
                                        <li>Email: ${email}</li>
                                        <li>Password: ${userPassword}</li>
                                        <li>Phone: ${phoneNumber}</li>
                                    </ul>
                                </li>
                                <li>התוכנה תיצור עבורך מפתח רישיון אוטומטית</li>
                                <li>!הפלאגין יופעל</li>
                            </ol>
                        </div>
                        
                        <div style="background: #dbeafe; padding: 15px; border-radius: 8px; margin-top: 20px;">
                            <h3 style="color: #1e40af; margin-top: 0;">💬 צריך עזרה?</h3>
                            <p style="color: #1e3a8a; margin: 5px 0;">WhatsApp: <a href="https://wa.me/972534372335" style="color: #1e40af;">+972-53-437-2335</a></p>
                            <p style="color: #1e3a8a; margin: 5px 0;">Email: support@lashon-captions.com</p>
                        </div>
                        
                        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
                            <p style="color: #6b7280; font-size: 14px;">
                                Hebrew Auto-Captions by Lashon<br>
                                Professional Hebrew transcription for Adobe Premiere Pro
                            </p>
                        </div>
                    </div>
                `;
            } else {
                // Email for EXISTING accounts
                emailSubject = '🎉 טוקן ההפעלה שלך - Hebrew Auto-Captions';
                emailHtml = `
                    <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                        <h1 style="color: #dc2626; text-align: center;">🎉 !תודה על הרכישה</h1>
                        
                        <div style="background: #dcfce7; padding: 20px; border-radius: 10px; margin: 20px 0; border-right: 4px solid #22c55e;">
                            <h2 style="color: #15803d; margin-top: 0;">🎫 טוקן ההפעלה שלך:</h2>
                            
                            <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
                                <div style="font-family: 'Courier New', monospace; font-size: 28px; color: #dc2626; font-weight: 700; letter-spacing: 2px;">
                                    ${activationToken}
                                </div>
                            </div>
                            
                            <p style="color: #15803d; margin-top: 15px; font-size: 14px;">
                                טוקן זה הוא אישי ולשימוש חד-פעמי. תצטרך אותו בשלב ההפעלה.
                            </p>
                        </div>
                        
                        <div style="background: #f3f4f6; padding: 20px; border-radius: 10px; margin: 20px 0;">
                            <h2 style="color: #1f2937; margin-top: 0;">📝 פרטי החשבון שלך:</h2>
                            <p style="color: #4b5563;">תשתמש בפרטי החשבון הקיימים שלך (Email + Password + Phone) יחד עם הטוקן החדש.</p>
                        </div>
                        
                        <div style="margin-top: 30px;">
                            <h3 style="color: #1f2937;">📋 צעדים הבאים:</h3>
                            <ol style="line-height: 2; color: #374151;">
                                <li>הורד את הקבצים מ-Gumroad</li>
                                <li>הרץ את <strong>HebrewCaptions-Activate.exe</strong></li>
                                <li>הזן את 4 הפרטים:
                                    <ul>
                                        <li><strong>Token:</strong> ${activationToken} (הטוקן החדש למעלה)</li>
                                        <li><strong>Email:</strong> ${email}</li>
                                        <li><strong>Password:</strong> (הסיסמה שלך)</li>
                                        <li><strong>Phone:</strong> ${phoneNumber}</li>
                                    </ul>
                                </li>
                                <li>התוכנה תיצור עבורך מפתח רישיון אוטומטית</li>
                                <li>!הפלאגין יופעל</li>
                            </ol>
                        </div>
                        
                        <div style="background: #fef3c7; padding: 15px; border-radius: 8px; border-right: 4px solid #f59e0b; margin-top: 20px;">
                            <h3 style="color: #92400e; margin-top: 0;">⚠️ חשוב לדעת</h3>
                            <p style="color: #78350f; margin: 5px 0;">• הטוקן תקף ל-30 יום</p>
                            <p style="color: #78350f; margin: 5px 0;">• ניתן להשתמש בו פעם אחת בלבד</p>
                            <p style="color: #78350f; margin: 5px 0;">• מפתח הרישיון יהיה נעול למחשב שלך</p>
                        </div>
                        
                        <div style="background: #dbeafe; padding: 15px; border-radius: 8px; margin-top: 20px;">
                            <h3 style="color: #1e40af; margin-top: 0;">💬 צריך עזרה?</h3>
                            <p style="color: #1e3a8a; margin: 5px 0;">WhatsApp: <a href="https://wa.me/972534372335" style="color: #1e40af;">+972-53-437-2335</a></p>
                            <p style="color: #1e3a8a; margin: 5px 0;">Email: support@lashon-captions.com</p>
                        </div>
                        
                        <div style="text-align: center; margin-top: 30px; padding-top: 20px; border-top: 1px solid #e5e7eb;">
                            <p style="color: #6b7280; font-size: 14px;">
                                Hebrew Auto-Captions by Lashon<br>
                                Professional Hebrew transcription for Adobe Premiere Pro
                            </p>
                        </div>
                    </div>
                `;
            }
            
            await emailTransporter.sendMail({
                from: `"Lashon - Hebrew Captions" <${CONFIG.EMAIL_FROM}>`,
                to: email,
                subject: emailSubject,
                html: emailHtml
            });
            
            console.log('✅ Email sent to:', email);
            console.log('📧 Email type:', isNewAccount ? 'NEW ACCOUNT' : 'EXISTING ACCOUNT');
        } else {
            console.warn('⚠️  Email transporter not configured - skipping email');
        }
        
        // Success response
        console.log('✅ WEBHOOK PROCESSED SUCCESSFULLY\n');
        res.json({
            success: true,
            message: 'Purchase processed successfully',
            activationToken: activationToken,
            userId: userId,
            isNewAccount: isNewAccount
        });
        
    } catch (error) {
        console.error('❌ WEBHOOK ERROR:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// Alternative endpoint in case Gumroad blacklisted the original URL
// Use this URL in Gumroad if the main one doesn't work:
// https://lashon.onrender.com/webhook/gumroad-v2
app.post('/webhook/gumroad-v2', async (req, res) => {
    console.log('\n🔔 WEBHOOK RECEIVED (V2 ENDPOINT):', new Date().toISOString());
    console.log('Body:', JSON.stringify(req.body, null, 2));
    
    try {
        // Verify webhook
        if (!verifyGumroadWebhook(req.body, req.headers['x-signature'])) {
            console.error('❌ Invalid webhook signature');
            return res.status(401).json({ error: 'Invalid signature' });
        }

        // Extract purchase info
        const {
            sale_id,
            email,
            full_name,
            product_name,
            price,
            currency,
            custom_fields
        } = req.body;

        console.log('📧 Customer Email:', email);
        console.log('👤 Customer Name:', full_name || 'undefined');
        console.log('💰 Amount:', price || 'undefined', currency || 'undefined');

        // Check if this sale was already processed
        const existingDoc = await db.collection('purchases').doc(sale_id).get();
        if (existingDoc.exists) {
            console.log('⚠️ Sale already processed - skipping');
            return res.json({ 
                success: true, 
                message: 'Already processed',
                duplicate: true 
            });
        }

        // Mark sale as processed
        await db.collection('purchases').doc(sale_id).set({
            email: email,
            processedAt: new Date().toISOString()
        });

        // Get or create user in Firebase
        let userId;
        let phoneNumber = 'none';
        let isNewUser = false;
        
        try {
            // Try to find existing user
            const userRecord = await admin.auth().getUserByEmail(email);
            userId = userRecord.uid;
            console.log('✅ Found existing Firebase user:', userId);
            
            // Get phone number from existing user document
            const userDoc = await db.collection('users').doc(userId).get();
            if (userDoc.exists) {
                const userData = userDoc.data();
                phoneNumber = userData.phoneNumber || 'none';
                console.log('📱 Phone from existing user:', phoneNumber);
            }
        } catch (error) {
            // User doesn't exist - create new one
            console.log('ℹ️ User not found - creating new Firebase user');
            
            try {
                const newUserRecord = await admin.auth().createUser({
                    email: email,
                    emailVerified: true,
                    password: 'Lashon2025', // Default password
                    displayName: full_name || 'Customer'
                });
                
                userId = newUserRecord.uid;
                isNewUser = true;
                phoneNumber = 'none';
                
                console.log('✅ Created new Firebase user:', userId);
                
                // Create user document
                await db.collection('users').doc(userId).set({
                    email: email,
                    phoneNumber: phoneNumber,
                    trialStartTime: Date.now(),
                    secondsUsed: 0,
                    createdAt: admin.firestore.FieldValue.serverTimestamp(),
                    createdBy: 'gumroad-webhook'
                });
                
                console.log('✅ User document created');
            } catch (createError) {
                console.error('❌ Error creating user:', createError);
                return res.status(500).json({
                    success: false,
                    error: 'Failed to create user account'
                });
            }
        }

        // Generate activation token
        const activationToken = generateActivationToken();
        console.log('🔑 Generated activation token:', activationToken);

        // Update user document with purchase info
        const purchaseInfo = {
            saleId: sale_id,
            purchaseDate: new Date().toISOString(),
            phoneNumber: phoneNumber
        };
        
        if (product_name) purchaseInfo.productName = product_name;
        if (price) purchaseInfo.price = price;
        if (currency) purchaseInfo.currency = currency;
        if (full_name) purchaseInfo.customerName = full_name;
        
        await db.collection('users').doc(userId).set({
            purchaseInfo: purchaseInfo
        }, { merge: true });
        console.log('✅ Purchase info added to user document');

        // Store activation token in Firestore
        await db.collection('activationTokens').doc(activationToken).set({
            email: email,
            phoneNumber: phoneNumber,
            createdAt: new Date().toISOString(),
            used: false
        });
        console.log('✅ Activation token stored in Firestore');

        // Send activation email
        const emailSubject = '🎉 טוקן ההפעלה שלך - Hebrew Auto-Captions';
        const newUserSection = isNewUser ? `
            <div style="background: #dbeafe; padding: 20px; border-radius: 10px; margin: 20px 0; border-right: 4px solid #3b82f6;">
                <h2 style="color: #1e40af; margin-top: 0;">🔐 פרטי החשבון שלך:</h2>
                <p style="color: #1e40af; font-size: 14px; margin: 10px 0;">
                    <strong>אימייל:</strong> ${email}<br>
                    <strong>סיסמה:</strong> Lashon2025
                </p>
                <p style="color: #1e40af; font-size: 12px; margin: 10px 0;">
                    השתמש בפרטים אלה כדי להתחבר לתוסף ב-Premiere Pro
                </p>
            </div>
        ` : '';
        
        const emailHtml = `
            <div dir="rtl" style="font-family: Arial, sans-serif; max-width: 600px; margin: 0 auto; padding: 20px;">
                <h1 style="color: #dc2626; text-align: center;">🎉 !תודה על הרכישה</h1>
                
                ${newUserSection}
                
                <div style="background: #dcfce7; padding: 20px; border-radius: 10px; margin: 20px 0; border-right: 4px solid #22c55e;">
                    <h2 style="color: #15803d; margin-top: 0;">🎫 טוקן ההפעלה שלך:</h2>
                    
                    <div style="background: white; padding: 20px; border-radius: 8px; text-align: center;">
                        <div style="font-family: 'Courier New', monospace; font-size: 28px; color: #dc2626; font-weight: 700; letter-spacing: 2px;">
                            ${activationToken}
                        </div>
                    </div>
                    
                    <p style="color: #15803d; margin-top: 15px; font-size: 14px;">
                        העתק את הטוקן הזה והשתמש בו בתוכנת ההפעלה
                    </p>
                </div>

                <div style="background: #fef3c7; padding: 15px; border-radius: 8px; margin: 20px 0; border-right: 4px solid #f59e0b;">
                    <p style="margin: 0; color: #92400e; font-weight: 600;">⚠️ שים לב:</p>
                    <p style="margin: 5px 0 0 0; color: #92400e;">הטוקן הזה קשור למחשב שלך. תצטרך להריץ את תוכנת ההפעלה מהמחשב שבו תשתמש בתוסף.</p>
                </div>

                <div style="margin-top: 30px; padding-top: 20px; border-top: 2px solid #e5e7eb;">
                    <p style="color: #6b7280; font-size: 12px; text-align: center;">
                        Hebrew Auto-Captions by Lashon<br>
                        צריך עזרה? צור קשר: +972534372335
                    </p>
                </div>
            </div>
        `;

        // Send email using Resend API (not SMTP!)
        if (CONFIG.EMAIL_SERVICE === 'resend' && CONFIG.RESEND_API_KEY) {
            // Use Resend HTTP API (reliable, no SMTP blocking!)
            const resendResponse = await fetch('https://api.resend.com/emails', {
                method: 'POST',
                headers: {
                    'Authorization': `Bearer ${CONFIG.RESEND_API_KEY}`,
                    'Content-Type': 'application/json'
                },
                body: JSON.stringify({
                    from: `Hebrew Auto-Captions <${CONFIG.EMAIL_FROM}>`,
                    to: [email],
                    subject: emailSubject,
                    html: emailHtml
                })
            });

            if (!resendResponse.ok) {
                const errorData = await resendResponse.json();
                throw new Error(`Resend API error: ${JSON.stringify(errorData)}`);
            }

            console.log('✅ Email sent via Resend API to:', email);
        } else {
            // Fallback to nodemailer (Gmail SMTP - will likely fail)
            await transporter.sendMail({
                from: `"Hebrew Auto-Captions" <${CONFIG.EMAIL_FROM}>`,
                to: email,
                subject: emailSubject,
                html: emailHtml
            });
            console.log('✅ Email sent via SMTP to:', email);
        }

        console.log('✅ WEBHOOK PROCESSED SUCCESSFULLY');

        res.json({
            success: true,
            message: 'Purchase processed',
            activationToken: activationToken
        });

    } catch (error) {
        console.error('❌ WEBHOOK ERROR:', error);
        res.status(500).json({
            success: false,
            error: error.message
        });
    }
});

// ============================================================
// HEALTH CHECK ENDPOINT
// ============================================================

app.get('/', (req, res) => {
    res.json({
        status: 'online',
        service: 'Hebrew Captions - Gumroad Webhook',
        timestamp: new Date().toISOString(),
        config: {
            firebase: !!CONFIG.FIREBASE_PROJECT_ID,
            email: !!CONFIG.EMAIL_USER,
            webhookSecret: !!CONFIG.GUMROAD_WEBHOOK_SECRET
        }
    });
});

app.get('/health', (req, res) => {
    res.json({ status: 'healthy', timestamp: new Date().toISOString() });
});

// ============================================================
// START SERVER
// ============================================================

app.listen(CONFIG.PORT, () => {
    console.log('\n' + '='.repeat(60));
    console.log('🚀 GUMROAD WEBHOOK SERVER RUNNING');
    console.log('='.repeat(60));
    console.log(`📡 Port: ${CONFIG.PORT}`);
    console.log(`🔥 Firebase: ${CONFIG.FIREBASE_PROJECT_ID}`);
    console.log(`📧 Email: ${CONFIG.EMAIL_USER || 'NOT CONFIGURED'}`);
    console.log('='.repeat(60) + '\n');
});

module.exports = app;
