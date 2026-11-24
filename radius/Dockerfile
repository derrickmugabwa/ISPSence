FROM freeradius/freeradius-server:3.2.10@sha256:cc7fd136e7b03e7b332d94297530318e824a4ecfedbce54562cced723e71e812
RUN rm -f /etc/raddb/sites-enabled/default /etc/raddb/sites-enabled/inner-tunnel /etc/raddb/mods-enabled/eap
COPY clients.conf /etc/raddb/clients.conf
COPY billing-rest /etc/raddb/mods-enabled/billing-rest
COPY billing-lab /etc/raddb/sites-enabled/billing-lab
COPY check-lab.sh /usr/local/bin/check-billing-lab
RUN sed -i 's/\r$//' /usr/local/bin/check-billing-lab && chmod 755 /usr/local/bin/check-billing-lab
CMD ["freeradius", "-l", "stdout"]
