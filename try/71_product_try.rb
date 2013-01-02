require 'stella'

#Stella.debug = true
Stella.load! :tryouts

p Stella::Product.default

Stella::Host.destroy! :hostid => '71stellaaahhhh.com'
Stella::Product.all(:customer => @cust).destroy

Stella::Logic.safedb do
  @cust = Stella::Customer.first_or_create :email => 'tryouts71@blamestella.com'
  @host = Stella::Host.first_or_create :customer => @cust, :hostname => '71stellaaahhhh.com'
end

## Has defined products
Stella::Product.products.empty?
#=> false

## Has a free product
Stella::Product.product(:site_free_v1)['price']
#=> 0.0

## Has a paid product
Stella::Product.product(:site_basic_v1)['price']
#=> 2.0

## Has a default product
Stella::Product.default
#=> 'site_free_v1'


## Can create an instance
Stella::Logic.safedb do
  @prod1 = Stella::Product.create(@cust, :site_basic_v1, 0.5)
  @prod1.price
end
#=> 2.0

## Add product to host
@prod2 = @host.update_product :site_basic_v1
@host.product.options['pages']
#=> 3

## Will deactive previous product
@prod3 = @host.update_product :site_premium_v1
[@prod2.active, @prod3.active]
#=> [false, true]

#host.product.options['pages']

Stella::Host.all(:customer => @cust).destroy
Stella::Product.all(:customer => @cust).destroy
@cust.destroy! if @cust
