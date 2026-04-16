import { SESv2Client, SendEmailCommand } from '@aws-sdk/client-sesv2'

import {
  SES_REGION,
  EMAIL_FROM_ADDRESS,
  SUPPORT_EMAIL,
  CONTACT_RECIPIENT,
  EMAIL_BACKEND,
} from './config.js'

const supportEmail = SUPPORT_EMAIL || 'support@example.com'
const fromEmailAddress = EMAIL_FROM_ADDRESS || 'noreply@example.com'
const emailEnabled = EMAIL_BACKEND !== 'console'

const sesClient = emailEnabled ? new SESv2Client({ region: SES_REGION }) : null

async function sendEmail(params: { to: string; subject: string; textBody: string; htmlBody?: string }): Promise<void> {
  if (!sesClient) {
    return
  }

  const { to, subject, textBody, htmlBody } = params

  const command = new SendEmailCommand({
    FromEmailAddress: fromEmailAddress,
    Destination: {
      ToAddresses: [to],
    },
    Content: {
      Simple: {
        Subject: {
          Data: subject,
          Charset: 'UTF-8',
        },
        Body: {
          Text: {
            Data: textBody,
            Charset: 'UTF-8',
          },
          ...(htmlBody
            ? {
                Html: {
                  Data: htmlBody,
                  Charset: 'UTF-8',
                },
              }
            : {}),
        },
      },
    },
  })

  await sesClient.send(command)
}

export async function sendWelcomeEmail(params: { to: string; displayName: string }): Promise<void> {
  const { to, displayName } = params
  const subject = 'Welcome to Goldmann VF'
  const textBody = [
    `Hi ${displayName},`,
    '',
    'Welcome to Goldmann VF. Your account has been created and you can now securely save your visual field test results.',
    `Questions? Email us at ${supportEmail}.`,
    '',
    `This email was sent automatically from ${fromEmailAddress}.`,
  ].join('\n')

  await sendEmail({ to, subject, textBody })
}

export async function sendEmailChangedNotice(params: { to: string; displayName: string; newEmail: string }): Promise<void> {
  const { to, displayName, newEmail } = params
  const subject = 'Your email address was changed'
  const textBody = [
    `Hi ${displayName},`,
    '',
    `Your email address has been changed to ${newEmail}.`,
    'If you did not request this change, please contact support immediately.',
    `Support: ${supportEmail}`,
    '',
    `This email was sent automatically from ${fromEmailAddress}.`,
  ].join('\n')

  await sendEmail({ to, subject, textBody })
}

export async function sendPasswordResetInvite(params: { to: string; displayName: string; resetUrl: string }): Promise<void> {
  const { to, displayName, resetUrl } = params
  const subject = 'Password reset'
  const textBody = [
    `Hi ${displayName},`,
    '',
    'You requested a password reset.',
    'Use the link below (valid for 30 minutes):',
    resetUrl,
    '',
    'If you did not request this, you can safely ignore this email.',
    `Support: ${supportEmail}`,
    '',
    `This email was sent automatically from ${fromEmailAddress}.`,
  ].join('\n')

  await sendEmail({ to, subject, textBody })
}

export async function sendContactMessage(params: { name: string; email: string; message: string }): Promise<void> {
  const { name, email, message } = params
  const subject = `Contact form: ${name}`
  const textBody = [
    `New message from the contact form:`,
    '',
    `Name: ${name}`,
    `Email: ${email}`,
    '',
    `Message:`,
    message,
  ].join('\n')

  await sendEmail({ to: CONTACT_RECIPIENT || supportEmail, subject, textBody })
}

export async function sendPasswordChangedNotice(params: { to: string; displayName: string }): Promise<void> {
  const { to, displayName } = params
  const subject = 'Your password was changed'
  const textBody = [
    `Hi ${displayName},`,
    '',
    'Your password has been changed.',
    'If you did not do this, please contact support immediately.',
    `Support: ${supportEmail}`,
    '',
    `This email was sent automatically from ${fromEmailAddress}.`,
  ].join('\n')

  await sendEmail({ to, subject, textBody })
}
