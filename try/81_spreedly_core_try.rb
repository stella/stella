require 'stella'

require 'spreedly-core-ruby'
require 'spreedly-core-ruby/test_extensions'

#SpreedlyCore::Base.debug_output $stdout

Stella.load! :tryouts

ENV['SPREEDLYCORE_API_LOGIN']= Stella.config['vendor.spreedlycore.key']
ENV['SPREEDLYCORE_API_SECRET'] = Stella.config['vendor.spreedlycore.secret']
ENV['SPREEDLYCORE_GATEWAY_TOKEN'] = Stella.config['vendor.spreedlycore.testgateway']

## Has spreedly core key
ENV['SPREEDLYCORE_API_LOGIN'].to_s.empty?
#=> false

## Has spreedly core secret
ENV['SPREEDLYCORE_API_SECRET'].to_s.empty?
#=> false

## Has spreedly core test gateway
ENV['SPREEDLYCORE_GATEWAY_TOKEN'].to_s.empty?
#=> false

## Can configure SpreedlyCore
SpreedlyCore.configure
[SpreedlyCore::Base.login, SpreedlyCore::Base.gateway_token]
#=> [ENV['SPREEDLYCORE_API_LOGIN'], ENV['SPREEDLYCORE_GATEWAY_TOKEN']]

## Can create payment token
master_card_data = SpreedlyCore::TestHelper.cc_data(:master) # Lookup test credit card data
p token = SpreedlyCore::PaymentMethod.create_test_token(master_card_data)
token.to_s.empty?
#=> false

## Can find payment method from token
master_card_data = SpreedlyCore::TestHelper.cc_data(:master) 
master_card_data[:data] = { :custid => 'cust-tryouts-81' }
token = SpreedlyCore::PaymentMethod.create_test_token(master_card_data)
@payment_method = SpreedlyCore::PaymentMethod.find(token)
[@payment_method.card_type]
#=> ['master]

## Can make a payment with known token
purchase_transaction = @payment_method.purchase(1)
purchase_transaction.succeeded?
#=> true

## Payment returns false with bad cc
master_card_data = SpreedlyCore::TestHelper.cc_data(:master, :card_number => :failed) 
token = SpreedlyCore::PaymentMethod.create_test_token(master_card_data)
payment_method = SpreedlyCore::PaymentMethod.find(token)
purchase_transaction = payment_method.purchase(1)
purchase_transaction.succeeded?
#=> false

## Raises exception when authorizing with bad token
@payment_method.instance_variable_set("@token", "BAD-TOKEN")
begin
  @payment_method.authorize(1)
rescue SpreedlyCore::InvalidResponse => ex
  :success
end
#=> :success
