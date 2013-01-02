require 'stella'

Stella.debug = false
Stella.load! :tryouts

@cust = Stella::Customer.first_or_create :custid => :tryouts91, :email => 'tryouts06@blamestella.com'
@now = Time.parse('2012-05-08 23:26:17 UTC')

## Config has Sendgrid user
Stella.config['vendor.sendgrid.user'].to_s.empty?
#=> false

## Config has Sendgrid password
Stella.config['vendor.sendgrid.key'].to_s.empty?
#=> false

## SendGrid has config
[SendGrid.api_user, SendGrid.api_key, SendGrid.hostname]
#=> [Stella.config['vendor.sendgrid.user'], Stella.config['vendor.sendgrid.key'], Stella.sysinfo.hostname]

## Can send fake email
SendGrid.fake = true
email = SendGrid.send_email "subject line", "email content"
SendGrid.fake = false
email.status?(:fake_sent)
#=> true

## Can send email
opts = {
  :from => 'tryouts55+from@blamestella.com',
  :to => 'tryouts55@blamestella.com',
}
email = SendGrid.send_email "#{$0} #{SecureRandom.uuid}", "Welcome to #{@now}", opts
email.status?(:sent)
#=> true

## Express Confirmation
uri = 'https://host/account/claim/abc123'
args = [@cust, :hostname => 'tryouts91.com', :uri => uri]
view = Stella::Email::Account::ExpressConfirmation.new *args
view.render.match(uri).nil?
##=> false
