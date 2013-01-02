require "stella"

Stella.load! :tryouts

#Gibbler.debug = true 

class ::ScheduableTryout
  include DataMapper::Resource
  include Stella::Model::Schedulable
  include Gibbler::Complex
  attr_reader :objid
  def initialize v
    @objid = v.gibbler
  end
end

## Knows included classes
Stella::Model::Schedulable.classes.member?(ScheduableTryout)
#=> true

## Starting point stays the same for a given value
ScheduableTryout.new(:tryouts).starting_point
#=> 16

## Different starting point for a different value.
ScheduableTryout.new(:tryouts2).starting_point
#=> 5

## Default starting point is hourly
ScheduableTryout.new(:tryouts).starting_point :hour
#=> 16

## Starting point stays the same
ScheduableTryout.new(:tryouts).starting_point :day
#=> 22

## Starting point stays the same
ScheduableTryout.new(:tryouts).starting_point :week
#=> 3

## Starting point stays the same
ScheduableTryout.new(:tryouts).starting_point :month
#=> 5
