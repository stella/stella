require "stella"

Stella.load! :tryouts


## SendGrid
Stella::Vendors::SendGrid.send 'delano@solutious.com', "Tryouts #{__FILE__} (#{rand})", 'Body Content'
#=> true