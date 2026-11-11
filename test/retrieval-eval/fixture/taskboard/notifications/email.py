"""Email notifications over SMTP."""
import smtplib
from email.message import EmailMessage

TEMPLATES = {
    "task_due": "Reminder: '{title}' is due {when}.",
    "welcome": "Welcome to taskboard, {username}!",
}


def render(template, **values):
    return TEMPLATES[template].format(**values)


def send_email(config, to, subject, body):
    """Send a plain-text email using the SMTP_HOST and SMTP_PORT settings."""
    message = EmailMessage()
    message["To"] = to
    message["From"] = "taskboard@localhost"
    message["Subject"] = subject
    message.set_content(body)
    with smtplib.SMTP(config["SMTP_HOST"], config["SMTP_PORT"]) as smtp:
        smtp.send_message(message)


def notify_due(config, user, task, when):
    send_email(config, user.email, "Task reminder", render("task_due", title=task.title, when=when))
