import psutil
import smtplib
from email.mime.text import MIMEText


def check_disk_usage():
    disk_usage = psutil.disk_usage('/')
    percent_used = disk_usage.percent
    return percent_used


def send_email(subject, body):
    sender_email = '289672494@qq.com'
    receiver_email = '289672494@qq.com'
    password = 'rptcitgiwghxbggf'

    msg = MIMEText(body)
    msg['Subject'] = subject
    msg['From'] = sender_email
    msg['To'] = receiver_email

    server = smtplib.SMTP_SSL('smtp.qq.com', 465)
    server.login(sender_email, password)
    server.sendmail(sender_email, receiver_email, msg.as_string())
    server.quit()


def main():
    disk_usage_percent = check_disk_usage()
    if disk_usage_percent > 80:
        subject = '服务器磁盘空间不足告警!'
        body = f'Disk usage is {disk_usage_percent}%.'
        send_email(subject, body)


if __name__ == '__main__':
    main()

