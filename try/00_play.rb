require 'stella'

Stella.debug = true
Stella.load! :tryouts

# Trees in the orchard.
class Tree
  include DataMapper::Resource
  property :id, Serial

  has n, :apples    # "a tree has many apples"
  has n, :seeds, :through => :apples
end

# Apples on a Tree.
class Apple
  include DataMapper::Resource
  property :id, Serial

  belongs_to :tree # "an apple belongs to a tree..."
  has n, :seeds    # "...and has many seeds"
end

# Seeds in an Apple
class Seed
  include DataMapper::Resource
  property :id, Serial

  belongs_to :apple  # "and a seed belongs to an apple"
end

DataMapper.finalize.auto_upgrade!

