import { BackButton } from './AccessibleNav'
import { SUPPORT_EMAIL, HAS_SUPPORT_EMAIL } from '../branding'

interface Props {
  onBack: () => void
}

export function PrivacyPage({ onBack }: Props) {
  const emailLink = HAS_SUPPORT_EMAIL ? (
    <a href={`mailto:${SUPPORT_EMAIL}`} className="text-accent hover:text-accent-light underline">{SUPPORT_EMAIL}</a>
  ) : (
    <span className="text-zinc-400">your deployment's support address</span>
  )
  return (
    <main className="min-h-[100dvh] bg-base text-white safe-pad p-6 animate-page-in">
      <div className="max-w-3xl mx-auto space-y-8 pb-12">
        <div className="flex items-center justify-between pb-5 border-b border-white/[0.06]">
          <h1 className="text-3xl font-heading font-bold">Privacy Policy</h1>
          <BackButton onClick={onBack} label="Home" />
        </div>

        <p className="text-zinc-500 text-sm leading-relaxed">
          Last updated: April 2026
        </p>

        <div className="space-y-8">
          <Section title="In short">
            <p>
              Your visual field data stays on your device unless you explicitly sign in to sync it.
              I don't sell data, don't run ads, and don't use tracking cookies. I use privacy-friendly
              analytics (Umami) to understand how the tool is used.
            </p>
          </Section>

          <Section title="What data I collect">
            <Subsection title="Without an account">
              <ul className="list-disc list-inside space-y-1">
                <li>Test results are stored <strong className="text-white">only in your browser</strong> (localStorage). Nothing is sent to my servers.</li>
                <li>Calibration data (screen size, viewing distance, brightness) stays local.</li>
                <li>Anonymous usage analytics via <a href="https://umami.is" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-light underline">Umami</a> &mdash; no cookies, no personal data, no IP tracking.</li>
              </ul>
            </Subsection>
            <Subsection title="With an account">
              <ul className="list-disc list-inside space-y-1">
                <li><strong className="text-white">Email address</strong> &mdash; for login and password reset.</li>
                <li><strong className="text-white">Display name</strong> &mdash; shown in the app, optional.</li>
                <li><strong className="text-white">Password</strong> &mdash; stored as a salted hash (scrypt). I never see your actual password.</li>
                <li><strong className="text-white">Visual field results</strong> &mdash; synced to the cloud only when you sign in, so you can access them across devices.</li>
              </ul>
            </Subsection>
            <Subsection title="Contact form">
              <p>
                If you send a message via the contact form, I receive your name, email, and message.
                This is used solely to respond to your inquiry.
              </p>
            </Subsection>
          </Section>

          <Section title="What I don't do">
            <ul className="list-disc list-inside space-y-1">
              <li>I don't sell or share your data with third parties.</li>
              <li>I don't use advertising or tracking cookies.</li>
              <li>I don't use Google Analytics or similar invasive trackers.</li>
              <li>I don't profile you or build behavioral models.</li>
              <li>I don't send marketing emails.</li>
            </ul>
          </Section>

          <Section title="Analytics">
            <p>
              I use <a href="https://umami.is" target="_blank" rel="noopener noreferrer" className="text-accent hover:text-accent-light underline">Umami</a>,
              a privacy-friendly, open-source analytics tool. It collects anonymous page view data
              without cookies, without personal identifiers, and without tracking across sites.
              This helps me understand which features are used and improve the tool.
            </p>
          </Section>

          <Section title="Where data is stored">
            <p>
              Account data and synced results are stored in AWS (DynamoDB) in the EU (Ireland, eu-west-1).
              Emails are sent via AWS SES. Local test results never leave your browser unless you sign in.
            </p>
          </Section>

          <Section title="Data retention & deletion">
            <p>
              You can delete individual test results at any time. If you want your
              account and all associated data deleted entirely, contact me
              at {emailLink} and
              I'll remove everything within 30 days.
            </p>
          </Section>

          <Section title="Your rights (GDPR)">
            <p>
              Under GDPR, EU residents have the right to access, correct, export, or delete their
              personal data, as well as object to processing or request restriction. I extend
              these same rights to all users, regardless of where you live. Contact
              me at {emailLink} for
              any of these requests.
            </p>
          </Section>

          <Section title="Contact">
            <p>
              Dani&euml;l Tom<br />
              The Hague, Netherlands<br />
              {emailLink}
            </p>
          </Section>
        </div>
      </div>
    </main>
  )
}

function Section({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-3">
      <h2 className="text-lg font-heading font-bold text-white">{title}</h2>
      <div className="text-sm text-zinc-300 leading-relaxed space-y-3">{children}</div>
    </div>
  )
}

function Subsection({ title, children }: { title: string; children: React.ReactNode }) {
  return (
    <div className="space-y-2">
      <h3 className="text-sm font-medium text-zinc-200">{title}</h3>
      {children}
    </div>
  )
}
