#!/usr/bin/env bash
# Container entrypoint. Sets the dev user's password, then runs sshd in the
# foreground. There is no key handling at all - see the note in the Dockerfile.
set -euo pipefail

DEV_USER="${DEV_USER:-dev}"

# Password for the dev user.
#   DEV_PASSWORD unset -> 'dev'
#   DEV_PASSWORD=""    -> no password at all (blank field / just press enter)
if [ "${DEV_PASSWORD-dev}" = "" ]; then
    passwd -d "$DEV_USER" >/dev/null
    echo "entrypoint: user '$DEV_USER' has NO password - leave the field blank"
else
    printf '%s:%s\n' "$DEV_USER" "${DEV_PASSWORD-dev}" | chpasswd
    echo "entrypoint: user '$DEV_USER' password is '${DEV_PASSWORD-dev}'"
fi

ssh-keygen -A            # host keys on first boot, not baked into the image
echo "entrypoint: sshd listening on 22, login user '$DEV_USER'"
exec /usr/sbin/sshd -D -e
