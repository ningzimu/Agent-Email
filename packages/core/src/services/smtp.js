function _isTestMode() {
  return String(process.env.MAILBOX_INTERNAL_TEST_MODE || "").trim() === "1";
}

function _allowInsecureTls() {
  return String(process.env.MAILBOX_ALLOW_INSECURE_TLS || "").trim() === "1";
}

function _buildTransportOptions(account) {
  const port = Number(account.smtp.port);
  const secure = Boolean(account.smtp.secure);
  const opts = {
    host: account.smtp.host,
    port,
    secure,
    auth: {
      user: account.email,
      pass: account.password,
    },
    tls: {
      rejectUnauthorized: !_allowInsecureTls(),
      minVersion: "TLSv1.2",
    },
  };
  // Implicit TLS (465): no STARTTLS upgrade. For everything else (587, 25, custom),
  // require STARTTLS so a hostile MITM can't strip TLS and force plaintext auth.
  if (!secure) {
    opts.requireTLS = true;
  }
  return opts;
}

async function testConnection(account) {
  if (_isTestMode()) {
    return { success: true };
  }

  if (!account || !account.smtp || !account.smtp.host) {
    return { success: false, error: "Missing SMTP host" };
  }

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport(_buildTransportOptions(account));

  try {
    await transporter.verify();
    return { success: true };
  } catch (e) {
    return { success: false, error: e && e.message ? e.message : "SMTP verify failed" };
  }
}

async function sendMail({ account, to, cc, bcc, subject, text, html, attachments, headers }) {
  if (_isTestMode()) {
    return {
      success: true,
      messageId: "<mock-sent@example.com>",
    };
  }

  const nodemailer = require("nodemailer");
  const transporter = nodemailer.createTransport(_buildTransportOptions(account));

  const info = await transporter.sendMail({
    from: account.email,
    to,
    cc,
    bcc,
    subject,
    text,
    html,
    attachments,
    headers,
  });

  return {
    success: true,
    messageId: info.messageId || "",
  };
}

module.exports = {
  sendMail,
  testConnection,
};
