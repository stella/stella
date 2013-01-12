require 'stella'

Stella.debug = false
Stella.load! :tryouts

# https://github.com/webficient/twilio/blob/master/lib/twilio/sms.rb

@cust = Stella::Customer.first_or_create :custid => :tryouts07, :email => 'tryouts07@blamestella.com'
@now = Time.parse('2012-05-08 23:26:17 UTC')

## Config has Twilio sid
Stella.config['vendor.twilio.sid'].to_s.empty?
#=> false

## Config has Twilio token
Stella.config['vendor.twilio.token'].to_s.empty?
#=> false

## SendGrid has config
Twilio.default_options[:basic_auth].values
#=> [Stella.config['vendor.twilio.sid'], Stella.config['vendor.twilio.token']]

## Can send SMS
from = Stella.config['vendor.twilio.phone']
to = Stella.config['account.tech.phone']
Twilio::Sms.message(from, to, "#{$0} @ #{Time.now}")
#=> true
