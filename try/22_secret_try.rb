require 'stella'
#Stella.debug = true

Stella.load! :tryouts

## Can generate unique ID
sid = Stella::Secret.generate_id :poop
[sid.class, sid.size]
#=> [Gibbler, 40]

## Can instantiate
s = Stella::Secret.new 'someid'
[s.class, s.objid]
#=> [Stella::Secret, 'someid']

## Can create
s = Stella::Secret.create :name => 'value'
p s.objid
[s.class, s.objid.size, s[:name]]
#=> [Stella::Secret, 40, 'value']

