# criticality: low
"""Customer e-mails."""
import smtplib

from utils import render


def send_confirmation(customer, order_id):
    body = render("Hi {name}, your order {order} is confirmed.", name=customer["name"], order=order_id)
    with smtplib.SMTP("localhost") as smtp:
        smtp.sendmail("shop@example.com", customer["email"], body)
