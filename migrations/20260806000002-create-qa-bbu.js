"use strict";

module.exports = {
  async up(queryInterface, Sequelize) {
    await queryInterface.createTable("qa_bbu", {
      bbu_id: {
        type: Sequelize.UUID,
        primaryKey: true,
        defaultValue: Sequelize.UUIDV4,
      },
      qa_project_id: {
        type: Sequelize.UUID,
        allowNull: false,
        references: {
          model: "qa_registered_project",
          key: "qa_project_id",
        },
      },
      bbu_sl_no: {
        type: Sequelize.INTEGER,
        allowNull: false,
      },
      name_equipment: {
        type: Sequelize.STRING,
        allowNull: false,
      },
      uom: {
        type: Sequelize.STRING,
        allowNull: true,
      },
      quantity: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      unit_price: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      basic_price: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      gst: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      total_value: {
        type: Sequelize.FLOAT,
        allowNull: true,
      },
      createdAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
      updatedAt: {
        allowNull: false,
        type: Sequelize.DATE,
      },
    });
  },

  async down(queryInterface, Sequelize) {
    await queryInterface.dropTable("qa_bbu");
  },
};