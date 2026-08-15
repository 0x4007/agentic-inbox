#!/usr/bin/env python3
"""Send one live-acceptance test email to the isolated test alias via the
pavlovcik.com MX (Cloudflare Email Routing). This is the same delivery path a
real sender uses; Email Routing routes the alias to the agentic-inbox Worker."""
import smtplib
import socket
import ssl
import sys
from email.message import EmailMessage
from email.utils import formatdate, make_msgid, formataddr

TO = "agentic-inbox-test@pavlovcik.com"
FROM_NAME = "Live Acceptance"
FROM_EMAIL = "nv.live.test@gmail.com"
SUBJECT = "Live acceptance test - inbound pipeline"
BODY = """This is the live acceptance test message for the agentic-inbox prototype.

It should be stored in the dashboard, forwarded to pavlovcik+cloudflare@gmail.com,
joined to any imported Gmail history, and processed per the thread automation
mode (draft first, then auto-send exactly once).

- idempotency marker: live-acceptance-001
"""

msg = EmailMessage()
msg["From"] = formataddr((FROM_NAME, FROM_EMAIL))
msg["To"] = TO
msg["Subject"] = SUBJECT
msg["Date"] = formatdate(localtime=True)
msg["Message-ID"] = make_msgid(domain="gmail.com")
msg["X-Live-Acceptance"] = "agentic-inbox-001"
msg.set_content(BODY)

mx_host = "route1.mx.cloudflare.net"
mx_port = 587
try:
    with smtplib.SMTP(mx_host, mx_port, timeout=30) as smtp:
        smtp.ehlo("localhost")
        smtp.starttls(context=ssl.create_default_context())
        smtp.ehlo("localhost")
        code, resp = smtp.mail(FROM_EMAIL)
        print("MAIL FROM:", code, resp)
        code, resp = smtp.rcpt(TO)
        print("RCPT TO:", code, resp)
        code, resp = smtp.data(msg.as_bytes())
        print("DATA:", code, resp)
        smtp.quit()
    print("SENT OK via", mx_host)
except Exception as e:
    print("SMTP ERROR:", type(e).__name__, e)
    sys.exit(1)
